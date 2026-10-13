import { DurableObject } from 'cloudflare:workers';
import { fromBlob, toBlob } from '../ml/contract';
import { refreshStaleFeatureFaces, syncFaceVectors } from '../people/repo';
import {
  clusterSettings,
  personCleanup,
  recognizeFace,
  unassignedFaceIds,
  unassignMachineFaces,
  type BufferedFace,
} from './cluster';

/** Faces written in the last two minutes are searched exactly in the hub, since Vectorize indexes writes with a delay. */
const BUFFER_MS = 2 * 60 * 1000;
/** One invocation works this long, then an alarm continues the run. */
const RUN_BUDGET_MS = 20_000;
const BATCH = 25;
const MAX_ATTEMPTS = 3;

/** Test seam: awaited after the hub reads a scan page from D1, before it writes the cursor. */
export const clusterHubTestHooks: { afterScanPage?: (hub: ClusterHub) => Promise<void> | void } = {};

/**
 * One instance per cluster group (`idFromName(clusterGroupId)`) runs Immich's incremental face clustering in strict
 * order. Faces wait in a SQLite queue: pass 1 handles every pending face (core faces found or join people; non-core
 * faces move to the deferred list), and the deferred list runs only when no pending face is left, so a deferred face
 * sees every person created before it. Requests:
 * - `POST /faces {faceIds}` (Task D, after storing new faces): queue them and remember their embeddings in the buffer;
 * - `POST /run {clusterGroupId, force}`: queue every unassigned machine face of the group; `force` first unassigns all
 *   machine-learning faces and deletes people left without faces (Immich's forced re-cluster);
 * - `GET /status`: queue sizes and whether a run is in progress.
 * POST requests answer 202 at once; the run happens in the alarm, continues from it when it outlasts one invocation
 * or a face fails (retried up to 3 times), and resumes from it after an eviction.
 */
export class ClusterHub extends DurableObject<Env> {
  private running: Promise<void> | null = null;
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS queue (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, face_id TEXT NOT NULL UNIQUE, deferred INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0)`);
    this.sql.exec('CREATE TABLE IF NOT EXISTS recent (face_id TEXT PRIMARY KEY, embedding BLOB NOT NULL, added_at INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS vsync (face_id TEXT PRIMARY KEY)');
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/status') return Response.json(this.status());
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (url.pathname === '/faces') {
      const ids = Array.isArray(body?.faceIds) ? body.faceIds.filter((v): v is string => typeof v === 'string') : null;
      if (!ids) return new Response('faceIds required', { status: 400 });
      await this.enqueueNew(ids);
    } else if (url.pathname === '/run') {
      if (typeof body?.clusterGroupId !== 'string') return new Response('clusterGroupId required', { status: 400 });
      this.startRun(body.clusterGroupId, body.force === true);
    } else {
      return new Response('not found', { status: 404 });
    }
    // the run happens in the alarm, so the caller never waits for clustering and never sees its errors
    await this.ctx.storage.setAlarm(Date.now());
    return Response.json(this.status(), { status: 202 });
  }

  async alarm(): Promise<void> {
    await this.kick();
  }

  /**
   * Records a `/run` request. Every request bumps the generation and restarts the scan cursor; the run loop writes
   * the cursor or clears `reset` only when the generation it read before its awaits is still current, so a request
   * that arrives while a page is being read is never overwritten.
   */
  startRun(clusterGroupId: string, force: boolean): void {
    const gen = String(Number(this.getState('gen') ?? '0') + 1);
    this.setState('gen', gen);
    this.setState('group', clusterGroupId);
    if (force) this.setState('reset', gen);
    this.setState('scan', '');
  }

  private currentGen(): string {
    return this.getState('gen') ?? '0';
  }

  private markVectorSync(ids: string[]): void {
    for (const id of ids) this.sql.exec('INSERT INTO vsync (face_id) VALUES (?) ON CONFLICT (face_id) DO NOTHING', id);
  }

  private clearVectorSync(ids: string[]): void {
    for (const id of ids) this.sql.exec('DELETE FROM vsync WHERE face_id = ?', id);
  }

  /** Faces whose D1 assignment changed but whose vector flag may not have (a failure between the two writes). */
  private async resyncVectors(): Promise<void> {
    const ids = this.sql.exec<{ face_id: string }>('SELECT face_id FROM vsync').toArray().map((r) => r.face_id);
    if (ids.length === 0) return;
    await syncFaceVectors(this.env, ids);
    this.clearVectorSync(ids);
  }

  private hasWork(): boolean {
    const queued = this.sql.exec<{ n: number }>('SELECT count(*) AS n FROM queue').one().n;
    return queued > 0 || this.getState('scan') !== null || this.getState('reset') !== null;
  }

  private remember(buffer: BufferedFace[], face: BufferedFace): void {
    buffer.push(face);
    this.sql.exec(
      'INSERT INTO recent (face_id, embedding, added_at) VALUES (?, ?, ?) ON CONFLICT (face_id) DO UPDATE SET embedding = excluded.embedding, added_at = excluded.added_at',
      face.id,
      toBlob(face.values).buffer,
      Date.now(),
    );
  }

  private status() {
    const row = this.sql
      .exec<{ pending: number; deferred: number }>(
        'SELECT coalesce(sum(deferred = 0), 0) AS pending, coalesce(sum(deferred = 1), 0) AS deferred FROM queue',
      )
      .one();
    return {
      pending: row.pending,
      deferred: row.deferred,
      scanning: this.getState('scan') !== null,
      resetting: this.getState('reset') !== null,
      running: this.running !== null,
    };
  }

  private getState(key: string): string | null {
    const rows = this.sql.exec<{ value: string }>('SELECT value FROM state WHERE key = ?', key).toArray();
    return rows.length ? rows[0].value : null;
  }

  private setState(key: string, value: string | null): void {
    if (value === null) this.sql.exec('DELETE FROM state WHERE key = ?', key);
    else this.sql.exec('INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value);
  }

  private async enqueueNew(faceIds: string[]): Promise<void> {
    if (faceIds.length === 0) return;
    const { results } = await this.env.DB.prepare(
      `SELECT f.id, f.cluster_group_id, e.embedding FROM asset_faces f LEFT JOIN face_embeddings e ON e.face_id = f.id
       WHERE f.id IN (SELECT value FROM json_each(?1))`,
    )
      .bind(JSON.stringify(faceIds))
      .all<{ id: string; cluster_group_id: string; embedding: ArrayBuffer | number[] | null }>();
    const now = Date.now();
    const known = new Map(results.map((r) => [r.id, r]));
    for (const id of faceIds) {
      const r = known.get(id);
      if (!r) continue;
      if (!this.getState('group')) this.setState('group', r.cluster_group_id);
      this.sql.exec('INSERT INTO queue (face_id) VALUES (?) ON CONFLICT (face_id) DO NOTHING', id);
      if (r.embedding) {
        this.sql.exec(
          'INSERT INTO recent (face_id, embedding, added_at) VALUES (?, ?, ?) ON CONFLICT (face_id) DO UPDATE SET embedding = excluded.embedding, added_at = excluded.added_at',
          id,
          new Uint8Array(r.embedding).buffer, // D1 returns a BLOB as an array of byte values
          now,
        );
      }
    }
  }

  private buffer(): BufferedFace[] {
    this.sql.exec('DELETE FROM recent WHERE added_at < ?', Date.now() - BUFFER_MS);
    return this.sql
      .exec<{ face_id: string; embedding: ArrayBuffer }>('SELECT face_id, embedding FROM recent')
      .toArray()
      .map((r) => ({ id: r.face_id, values: fromBlob(r.embedding) }));
  }

  /** Starts the run, or joins the one in progress (which picks up anything queued meanwhile). */
  private kick(): Promise<void> {
    if (!this.running) {
      this.running = this.run().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  /**
   * One bounded run. The alarm is moved past the budget first, so a hub evicted mid-run resumes from it; a finished
   * run deletes it (unless something was queued meanwhile), and an unfinished one continues a second later. Errors are
   * logged and leave the resume alarm in place.
   */
  private async run(): Promise<void> {
    const deadline = Date.now() + RUN_BUDGET_MS;
    await this.ctx.storage.setAlarm(deadline + 5000);
    try {
      const more = await this.work(deadline);
      if (more) await this.ctx.storage.setAlarm(Date.now() + 1000);
      else if (this.hasWork()) await this.ctx.storage.setAlarm(Date.now());
      else await this.ctx.storage.deleteAlarm();
    } catch (err) {
      console.error('cluster run failed', err);
    }
  }

  /** Returns true when work is left for the alarm. */
  private async work(deadline: number): Promise<boolean> {
    const settings = await clusterSettings(this.env.DB);
    const group = this.getState('group');
    if (!settings.enabled || !group) {
      // Immich skips facial recognition jobs while it is disabled; queued faces are dropped (the next run re-queues them).
      this.sql.exec('DELETE FROM queue');
      this.setState('reset', null);
      this.setState('scan', null);
      return false;
    }
    await this.resyncVectors();
    while (Date.now() < deadline) {
      const reset = this.getState('reset');
      if (reset !== null) {
        const gen = this.currentGen();
        const n = await unassignMachineFaces(this.env, group, 200, {
          // recorded before the D1 commit and cleared after the vector sync, so a failure in between is re-synced
          before: (ids) => this.markVectorSync(ids),
          after: (ids) => this.clearVectorSync(ids),
        });
        if (n === 0) {
          await personCleanup(this.env, group);
          // a force request that arrived meanwhile starts its own reset
          if (this.currentGen() === gen) this.setState('reset', null);
        }
        continue;
      }
      const deferredPass = this.sql.exec<{ n: number }>('SELECT count(*) AS n FROM queue WHERE deferred = 0').one().n === 0;
      if (deferredPass) {
        const scan = this.getState('scan');
        if (scan !== null) {
          const gen = this.currentGen();
          const ids = await unassignedFaceIds(this.env, group, scan);
          await clusterHubTestHooks.afterScanPage?.(this);
          // a /run that arrived during the read restarted the cursor; this page is stale
          if (this.currentGen() !== gen) continue;
          if (ids.length === 0) this.setState('scan', null);
          else {
            for (const id of ids) this.sql.exec('INSERT INTO queue (face_id) VALUES (?) ON CONFLICT (face_id) DO NOTHING', id);
            this.setState('scan', ids[ids.length - 1]);
          }
          continue;
        }
      }
      const batch = this.sql
        .exec<{ seq: number; face_id: string; deferred: number; attempts: number }>(
          'SELECT seq, face_id, deferred, attempts FROM queue WHERE deferred = ? ORDER BY seq LIMIT ?',
          deferredPass ? 1 : 0,
          BATCH,
        )
        .toArray();
      if (batch.length === 0) {
        // re-detection may have soft-deleted a feature face; pick new ones once the queue is empty
        await refreshStaleFeatureFaces(this.env, group);
        return false;
      }
      const buffer = this.buffer();
      for (const item of batch) {
        let result;
        try {
          result = await recognizeFace(this.env, settings, buffer, item.face_id, item.deferred === 1, (f) => this.remember(buffer, f));
        } catch (err) {
          console.error(`clustering face ${item.face_id} failed`, err);
          if (item.attempts + 1 >= MAX_ATTEMPTS) this.sql.exec('DELETE FROM queue WHERE seq = ?', item.seq);
          else this.sql.exec('UPDATE queue SET attempts = attempts + 1 WHERE seq = ?', item.seq);
          return true;
        }
        this.sql.exec('DELETE FROM queue WHERE seq = ?', item.seq);
        // Immich re-queues a deferred face at the end of the queue; here it waits for the deferred pass.
        if (result === 'deferred') this.sql.exec('INSERT INTO queue (face_id, deferred) VALUES (?, 1)', item.face_id);
        // a face queued while the deferred pass runs goes first
        if (deferredPass && this.sql.exec<{ n: number }>('SELECT count(*) AS n FROM queue WHERE deferred = 0').one().n > 0) break;
      }
    }
    return true;
  }
}
