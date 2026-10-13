import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HANDLED_CRONS, runScheduled } from '../src/cron/index';
import { purgeAssets } from '../src/cron/purge';
import { purgeDeletedUsers } from '../src/cron/purge-users';
import type { AssetRow } from '../src/db/rows';
import { continueDuplicateRun, mlCluster, mlHooks, mlStats, startMlQueue } from '../src/jobs/ml';
import { setState } from '../src/server/state';
import { fakeVectorStore } from '../src/ml/vectors';
import { authHeaders, BASE, createUser, login, uploadAsset } from './helpers';

const DAILY = HANDLED_CRONS[0];
const vec = (n: number) => Array.from({ length: 4 }, (_, i) => (i === n ? 1 : 0));

const call = async (token: string, method: string, path: string, body?: unknown) => {
  const res = await SELF.fetch(`${BASE}/api${path}`, {
    method,
    headers: { ...authHeaders(token), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

let n = 0;
async function asset(token: string, opts: { ready?: boolean; mlAt?: string | null; embedded?: boolean } = {}): Promise<string> {
  const id = (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(100 + n++)))).body.id as string;
  await env.DB.prepare('UPDATE assets SET status = ?2, ml_at = ?3 WHERE id = ?1')
    .bind(id, opts.ready === false ? 'pending' : 'ready', opts.mlAt ?? null)
    .run();
  if (opts.embedded) await env.DB.prepare("INSERT INTO smart_search (asset_id, embedding, model) VALUES (?1, x'00', 'm')").bind(id).run();
  return id;
}

async function face(assetId: string, ownerId: string, id: string, personGroupId: string | null, over: Record<string, unknown> = {}) {
  await env.DB.prepare(
    `INSERT INTO asset_faces (id, asset_id, owner_id, cluster_group_id, person_group_id, image_width, image_height, x1, y1, x2, y2, score,
       source_type, is_visible, deleted_at, updated_at, update_id)
     VALUES (?1, ?2, ?3, ?3, ?4, 100, 100, 1, 1, 50, 50, 0.9, 'machine-learning', ?5, NULL, '2026-01-01T00:00:00.000Z', 'u')`,
  )
    .bind(id, assetId, ownerId, personGroupId, over.visible ?? 1)
    .run();
  await env.DB.prepare("INSERT INTO face_embeddings (face_id, embedding) VALUES (?1, x'00')").bind(id).run();
}

async function person(ownerId: string, pg: string, faceId: string | null = null) {
  await env.DB.prepare("INSERT OR IGNORE INTO person_groups (id, cluster_group_id, created_at) VALUES (?1, ?2, '2026-01-01T00:00:00.000Z')").bind(pg, ownerId).run();
  await env.DB.prepare(
    "INSERT INTO people (owner_id, person_group_id, face_id, thumbnail_key, created_at, updated_at, update_id) VALUES (?1, ?2, ?3, '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'u')",
  )
    .bind(ownerId, pg, faceId)
    .run();
}

async function setup() {
  const admin = await createUser();
  const token = await login();
  return { token, ownerId: admin.id as string };
}

const sent = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.flatMap((c) => (c[0] as Array<{ body: unknown }>).map((m) => m.body));

afterEach(() => vi.restoreAllMocks());

describe('admin queues: smartSearch and faceDetection', () => {
  it('smartSearch start queues ready assets without an embedding; force queues every ready asset', async () => {
    const { token } = await setup();
    const missing = await asset(token);
    const withFaces = await asset(token, { mlAt: '2026-01-01T00:00:00.000Z' });
    const done = await asset(token, { mlAt: '2026-01-01T00:00:00.000Z', embedded: true });
    await asset(token, { ready: false });
    const spy = vi.spyOn(env.ML_QUEUE, 'sendBatch').mockResolvedValue(undefined as never);

    expect((await call(token, 'PUT', '/jobs/smartSearch', { command: 'start' })).status).toBe(200);
    const bodies = sent(spy) as Array<{ assetId: string }>;
    expect(bodies.map((b) => b.assetId).sort()).toEqual([missing, withFaces].sort());
    expect(bodies.find((b) => b.assetId === missing)).toEqual({ assetId: missing, clip: true, faces: true, force: true });
    expect(bodies.find((b) => b.assetId === withFaces)).toEqual({ assetId: withFaces, clip: true, faces: false, force: true });

    spy.mockClear();
    await call(token, 'PUT', '/jobs/smartSearch', { command: 'start', force: true });
    expect((sent(spy) as Array<{ assetId: string }>).map((b) => b.assetId).sort()).toEqual([missing, withFaces, done].sort());
  });

  it('faceDetection start queues assets the ML job has not run for; force queues faces only for all', async () => {
    const { token } = await setup();
    const fresh = await asset(token);
    const done = await asset(token, { mlAt: '2026-01-01T00:00:00.000Z' });
    const spy = vi.spyOn(env.ML_QUEUE, 'sendBatch').mockResolvedValue(undefined as never);
    await call(token, 'PUT', '/jobs/faceDetection', { command: 'start' });
    expect(sent(spy)).toEqual([{ assetId: fresh }]);
    spy.mockClear();
    await call(token, 'PUT', '/jobs/faceDetection', { command: 'start', force: true });
    const bodies = sent(spy) as Array<{ assetId: string }>;
    expect(bodies.map((b) => b.assetId).sort()).toEqual([fresh, done].sort());
    expect(bodies[0]).toMatchObject({ clip: false, faces: true, force: true });
  });

  it('force faceDetection first hard-deletes machine faces with audits and vector ids, keeping manual faces and embeddings', async () => {
    const { token, ownerId } = await setup();
    const a = await asset(token, { mlAt: '2026-01-01T00:00:00.000Z', embedded: true });
    await person(ownerId, 'pg1');
    await face(a, ownerId, 'ml1', 'pg1');
    await face(a, ownerId, 'man1', null);
    await env.DB.prepare("UPDATE asset_faces SET source_type = 'manual' WHERE id = 'man1'").run();
    await fakeVectorStore('face').upsert([
      { id: 'ml1', values: vec(0), namespace: ownerId },
      { id: 'man1', values: vec(1), namespace: ownerId },
    ]);
    vi.spyOn(env.ML_QUEUE, 'sendBatch').mockResolvedValue(undefined as never);
    await call(token, 'PUT', '/jobs/faceDetection', { command: 'start', force: true });
    expect((await env.DB.prepare('SELECT id FROM asset_faces').all<{ id: string }>()).results.map((r) => r.id)).toEqual(['man1']);
    expect((await env.DB.prepare('SELECT face_id FROM asset_face_audit').all<{ face_id: string }>()).results.map((r) => r.face_id)).toEqual(['ml1']);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM people').first('n')).toBe(0);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM smart_search').first('n')).toBe(1);
    expect((await fakeVectorStore('face').query(vec(0), { topK: 10 })).map((m) => m.id)).toEqual(['man1']);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM vector_delete_queue').first('n')).toBe(0);
  });

  it('force faceDetection with no ML queue is refused and deletes nothing; with the queue it clears ml_at', async () => {
    const { token, ownerId } = await setup();
    const a = await asset(token, { mlAt: '2026-01-01T00:00:00.000Z' });
    await face(a, ownerId, 'ml1', null);
    const bare = { ...env, ML_QUEUE: undefined } as unknown as Env;
    await expect(startMlQueue(bare, 'faceDetection', true, 4000)).rejects.toMatchObject({ status: 400 });
    expect(await env.DB.prepare('SELECT count(*) AS n FROM asset_faces').first('n')).toBe(1);
    expect(await env.DB.prepare('SELECT ml_at FROM assets WHERE id = ?1').bind(a).first('ml_at')).toBe('2026-01-01T00:00:00.000Z');
    // the send fails after the reset: ml_at is already null, so the daily cron re-queues the asset
    const failing = vi.spyOn(env.ML_QUEUE, 'sendBatch').mockRejectedValue(new Error('queue down'));
    await expect(startMlQueue(env, 'faceDetection', true, 4000)).rejects.toThrow('queue down');
    expect(await env.DB.prepare('SELECT count(*) AS n FROM asset_faces').first('n')).toBe(0);
    expect(await env.DB.prepare('SELECT ml_at FROM assets WHERE id = ?1').bind(a).first('ml_at')).toBeNull();
    const { enqueueMlPending } = await import('../src/jobs/ml');
    failing.mockReset().mockResolvedValue(undefined as never);
    const spy = failing;
    await enqueueMlPending(env);
    expect(sent(spy)).toEqual([{ assetId: a }]);
  });

  it('a paused queue does not start and a deleted asset is skipped', async () => {
    const { token } = await setup();
    const id = await asset(token);
    await env.DB.prepare("UPDATE assets SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1").bind(id).run();
    await asset(token);
    const spy = vi.spyOn(env.ML_QUEUE, 'sendBatch').mockResolvedValue(undefined as never);
    await call(token, 'PUT', '/jobs/smartSearch', { command: 'pause' });
    await call(token, 'PUT', '/jobs/smartSearch', { command: 'start' });
    expect(spy).not.toHaveBeenCalled();
    await call(token, 'PUT', '/jobs/smartSearch', { command: 'resume' });
    await call(token, 'PUT', '/jobs/smartSearch', { command: 'start' });
    expect(sent(spy)).toHaveLength(1);
  });
});

describe('admin queues: facialRecognition', () => {
  it('start makes one clustering request per cluster group with unassigned faces; force covers every group and sets force once', async () => {
    const { token, ownerId } = await setup();
    const a = await asset(token);
    await person(ownerId, 'pg1');
    await face(a, ownerId, 'f-unassigned', null);
    await face(a, ownerId, 'f-unassigned2', null);
    await face(a, ownerId, 'f-assigned', 'pg1');
    await face(a, ownerId, 'f-hidden', null, { visible: 0 });
    const req = vi.spyOn(mlCluster, 'requestClustering').mockResolvedValue(undefined);
    await call(token, 'PUT', '/jobs/facialRecognition', { command: 'start' });
    expect(req.mock.calls.map((c) => c.slice(1))).toEqual([[ownerId, { force: false }]]);
    req.mockClear();
    await call(token, 'PUT', '/jobs/facialRecognition', { command: 'start', force: true });
    expect(req.mock.calls.map((c) => c.slice(1))).toEqual([[ownerId, { force: true }]]);
  });
});

describe('admin queues: duplicateDetection', () => {
  it('start runs detection per owner with embedded, unchecked assets; force resets the check marks first', async () => {
    const { token, ownerId } = await setup();
    await asset(token, { embedded: true });
    const checked = await asset(token, { embedded: true });
    await env.DB.prepare("UPDATE assets SET duplicates_checked_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1").bind(checked).run();
    const detect = vi.spyOn(mlHooks, 'detectDuplicates').mockResolvedValue(1);
    await call(token, 'PUT', '/jobs/duplicateDetection', { command: 'start' });
    expect(detect).toHaveBeenCalledTimes(1);
    expect(detect.mock.calls[0].slice(1)).toEqual([ownerId, 150]); // DUPLICATE_CAP per call keeps D1 queries in budget
    detect.mockClear();
    await call(token, 'PUT', '/jobs/duplicateDetection', { command: 'start', force: true });
    expect(await env.DB.prepare('SELECT count(*) AS n FROM assets WHERE duplicates_checked_at IS NOT NULL').first('n')).toBe(0);
    expect(detect).toHaveBeenCalledTimes(1);
  });

  it('one start keeps going on the queue until every asset is checked, and the card shows the run', async () => {
    const { token } = await setup();
    for (let i = 0; i < 3; i++) await asset(token, { embedded: true });
    // each batch checks one asset
    const detect = vi.spyOn(mlHooks, 'detectDuplicates').mockImplementation(async (e) => {
      await e.DB.prepare('UPDATE assets SET duplicates_checked_at = ?1 WHERE id = (SELECT id FROM assets WHERE duplicates_checked_at IS NULL ORDER BY id LIMIT 1)')
        .bind(new Date().toISOString())
        .run();
      return 1;
    });
    const send = vi.spyOn(env.ML_QUEUE, 'send').mockResolvedValue(undefined as never);
    await call(token, 'PUT', '/jobs/duplicateDetection', { command: 'start' });
    expect(detect).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    const runId = (send.mock.calls[0][0] as { duplicateRun: string }).duplicateRun;
    expect((await mlStats(env)).duplicateDetection).toMatchObject({ active: 1, waiting: 2, completed: 1 });

    await continueDuplicateRun(env, 'superseded-run'); // a message of an older run does nothing
    expect(detect).toHaveBeenCalledTimes(1);

    await continueDuplicateRun(env, runId);
    expect(send).toHaveBeenCalledTimes(2);
    await continueDuplicateRun(env, runId);
    expect(detect).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenCalledTimes(2); // nothing left: the run ends instead of queueing another batch
    expect((await mlStats(env)).duplicateDetection).toMatchObject({ active: 0, waiting: 0, completed: 3 });
  });

  it('a run whose batch checks nothing ends at once, so the card goes idle', async () => {
    const { token } = await setup();
    await asset(token, { embedded: true });
    vi.spyOn(mlHooks, 'detectDuplicates').mockResolvedValue(0);
    const send = vi.spyOn(env.ML_QUEUE, 'send').mockResolvedValue(undefined as never);
    await call(token, 'PUT', '/jobs/duplicateDetection', { command: 'start' });
    expect(send).not.toHaveBeenCalled();
    expect((await mlStats(env)).duplicateDetection).toMatchObject({ active: 0, waiting: 0 });
  });

  it('the asset-ml consumer runs a duplicate batch even when ML is not configured', async () => {
    const run = vi.spyOn(mlHooks, 'detectDuplicates').mockResolvedValue(0);
    const { handleMlBatch } = await import('../src/ml/job');
    await setState(env.DB, 'duplicate_run', { id: 'r1', at: new Date().toISOString() });
    const { token } = await setup();
    await asset(token, { embedded: true });
    const msg = { body: { duplicateRun: 'r1' }, attempts: 1, ack: vi.fn(), retry: vi.fn() };
    await handleMlBatch({ messages: [msg] } as unknown as MessageBatch<{ duplicateRun: string }>, { ...env, ML_CONTAINER: undefined } as unknown as Env);
    expect(run).toHaveBeenCalledTimes(1);
    expect(msg.ack).toHaveBeenCalled();
  });
});

describe('queue statistics', () => {
  it('facialRecognition reports the cluster hubs: active while one holds faces or runs, idle when unreachable', async () => {
    const { token, ownerId } = await setup();
    const a = await asset(token);
    await face(a, ownerId, 'f1', null);
    const status = vi.spyOn(mlCluster, 'clusterStatus').mockResolvedValue({ pending: 3, deferred: 1, scanning: false, resetting: false, running: true });
    expect((await mlStats(env)).facialRecognition).toMatchObject({ active: 1, waiting: 4 });
    expect(status.mock.calls.map((c) => c[1])).toEqual([ownerId]);
    status.mockResolvedValue({ pending: 0, deferred: 0, scanning: false, resetting: false, running: false });
    expect((await mlStats(env)).facialRecognition).toMatchObject({ active: 0, waiting: 0 });
    status.mockRejectedValue(new Error('hub down'));
    expect((await mlStats(env)).facialRecognition).toMatchObject({ active: 0, waiting: 0 });
  });

  it('derive from ml_at, smart_search, duplicates_checked_at and faces, ignoring deleted assets', async () => {
    const { token, ownerId } = await setup();
    const a = await asset(token, { mlAt: '2026-01-01T00:00:00.000Z', embedded: true });
    await asset(token);
    const gone = await asset(token);
    await env.DB.prepare("UPDATE assets SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1").bind(gone).run();
    await asset(token, { embedded: true });
    await env.DB.prepare("UPDATE assets SET duplicates_checked_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1").bind(a).run();
    await person(ownerId, 'pg1');
    await face(a, ownerId, 'f1', 'pg1');
    await face(a, ownerId, 'f2', null);
    expect(await mlStats(env)).toEqual({
      smartSearch: { active: 0, completed: 2, failed: 0, delayed: 0, waiting: 2, paused: 0 },
      faceDetection: { active: 0, completed: 1, failed: 0, delayed: 0, waiting: 2, paused: 0 },
      // backlogs that are never queued report 0 waiting, so the web app shows the start buttons
      facialRecognition: { active: 0, completed: 1, failed: 0, delayed: 0, waiting: 0, paused: 0 },
      duplicateDetection: { active: 0, completed: 1, failed: 0, delayed: 0, waiting: 0, paused: 0 },
    });
    const queues = (await call(token, 'GET', '/queues')).body as Array<{ name: string; statistics: { waiting: number; completed: number } }>;
    expect(queues.find((q) => q.name === 'facialRecognition')!.statistics).toMatchObject({ waiting: 0, completed: 1 });
  });
});

describe('daily cron', () => {
  it('queues up to 500 ready assets with ml_at null and runs duplicate detection and the places backfill', async () => {
    const { token, ownerId } = await setup();
    const todo = await asset(token);
    await asset(token, { mlAt: '2026-01-01T00:00:00.000Z', embedded: true });
    await asset(token, { ready: false });
    const spy = vi.spyOn(env.ML_QUEUE, 'sendBatch').mockResolvedValue(undefined as never);
    const detect = vi.spyOn(mlHooks, 'detectDuplicates').mockResolvedValue(3);
    const places = vi.spyOn(mlHooks, 'backfillPlaces').mockResolvedValue(0);
    await runScheduled(DAILY, env);
    expect(sent(spy)).toEqual([{ assetId: todo }]);
    expect(detect.mock.calls.map((c) => c.slice(1))).toEqual([[ownerId, 150]]);
    expect(places.mock.calls.map((c) => c.slice(1))).toEqual([[300]]); // PLACES_CAP per invocation
  });

  it('requests clustering for groups with unassigned faces, after the purge steps', async () => {
    const { token, ownerId } = await setup();
    const a = await asset(token);
    await face(a, ownerId, 'u1', null);
    const req = vi.spyOn(mlCluster, 'requestClustering').mockResolvedValue(undefined);
    vi.spyOn(mlHooks, 'detectDuplicates').mockResolvedValue(0);
    await runScheduled(DAILY, env);
    expect(req.mock.calls.map((c) => c.slice(1))).toEqual([[ownerId, { force: false }]]);
  });

  it('runs the ML steps after every other daily step', async () => {
    const src = (await import('../src/cron/index.ts?raw')).default as string;
    const names = [...src.matchAll(/^\s+\['(\w+)', \(env\)/gm)].map((m) => m[1]);
    const first = names.indexOf('enqueueMlPending');
    expect(names.slice(first).sort()).toEqual(['backfillPlaces', 'detectDuplicates', 'enqueueMlPending', 'recognizeFaces']);
    expect(names.indexOf('purgeExpiredSessions')).toBeLessThan(first);
  });

  it('enqueues nothing for a zero limit', async () => {
    const { token } = await setup();
    await asset(token);
    const { enqueueMlPending } = await import('../src/jobs/ml');
    const spy = vi.spyOn(env.ML_QUEUE, 'sendBatch').mockResolvedValue(undefined as never);
    expect(await enqueueMlPending(env, 0)).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('a failing ML step does not stop the places backfill', async () => {
    await setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(mlHooks, 'detectDuplicates').mockRejectedValue(new Error('boom'));
    const places = vi.spyOn(mlHooks, 'backfillPlaces').mockResolvedValue(0);
    await asset((await login()), { embedded: true });
    await runScheduled(DAILY, env);
    expect(places).toHaveBeenCalled();
  });
});

describe('purge', () => {
  async function seedPurgeable() {
    const { token, ownerId } = await setup();
    const a = await asset(token, { mlAt: '2026-01-01T00:00:00.000Z', embedded: true });
    const keep = await asset(token, { mlAt: '2026-01-01T00:00:00.000Z', embedded: true });
    await face(a, ownerId, 'fa1', 'pg-gone');
    await face(a, ownerId, 'fa2', 'pg-keep');
    await face(keep, ownerId, 'fk1', 'pg-keep');
    await person(ownerId, 'pg-gone', 'fa1');
    await person(ownerId, 'pg-keep', 'fa2');
    await env.MEDIA.put('people/pg-gone.jpeg', 'x');
    await env.MEDIA.put('people/pg-keep.jpeg', 'x');
    await fakeVectorStore('clip').upsert([
      { id: a, values: vec(0), metadata: { ownerId } },
      { id: keep, values: vec(1), metadata: { ownerId } },
    ]);
    await fakeVectorStore('face').upsert([
      { id: 'fa1', values: vec(0), namespace: ownerId },
      { id: 'fa2', values: vec(1), namespace: ownerId },
      { id: 'fk1', values: vec(2), namespace: ownerId },
    ]);
    await env.DB.prepare("UPDATE assets SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1").bind(a).run();
    return { token, ownerId, a, keep };
  }
  const row = (id: string) => env.DB.prepare('SELECT * FROM assets WHERE id = ?1').bind(id).first<AssetRow>();
  const count = (sql: string, ...b: unknown[]) => env.DB.prepare(sql).bind(...b).first<number>('n');

  it('removes embeddings, faces, vectors, audits, and people left without faces', async () => {
    const { ownerId, a, keep } = await seedPurgeable();
    await purgeAssets(env, [(await row(a))!], new Date('2026-03-01T00:00:00.000Z'));

    expect(await count('SELECT count(*) AS n FROM smart_search WHERE asset_id = ?1', a)).toBe(0);
    expect(await count('SELECT count(*) AS n FROM smart_search WHERE asset_id = ?1', keep)).toBe(1);
    expect((await env.DB.prepare('SELECT id FROM asset_faces ORDER BY id').all<{ id: string }>()).results.map((r) => r.id)).toEqual(['fk1']);
    expect(await count('SELECT count(*) AS n FROM face_embeddings')).toBe(1);
    const audits = await env.DB.prepare('SELECT face_id, asset_id, owner_id, cluster_group_id FROM asset_face_audit ORDER BY face_id').all();
    expect(audits.results).toEqual([
      { face_id: 'fa1', asset_id: a, owner_id: ownerId, cluster_group_id: ownerId },
      { face_id: 'fa2', asset_id: a, owner_id: ownerId, cluster_group_id: ownerId },
    ]);
    // pg-gone lost its only face: person, audit, group and thumbnail go; pg-keep keeps a face in another asset
    expect((await env.DB.prepare('SELECT person_group_id FROM people').all<{ person_group_id: string }>()).results.map((r) => r.person_group_id)).toEqual(['pg-keep']);
    expect((await env.DB.prepare('SELECT person_group_id, owner_id FROM person_audit').all()).results).toEqual([{ person_group_id: 'pg-gone', owner_id: ownerId }]);
    expect((await env.DB.prepare('SELECT id FROM person_groups').all<{ id: string }>()).results.map((r) => r.id)).toEqual(['pg-keep']);
    expect(await env.MEDIA.head('people/pg-gone.jpeg')).toBeNull();
    expect(await env.MEDIA.head('people/pg-keep.jpeg')).not.toBeNull();
    // the surviving person's feature face was purged
    expect(await env.DB.prepare("SELECT face_id FROM people WHERE person_group_id = 'pg-keep'").first('face_id')).toBeNull();
    // vectors left Vectorize and the queue is empty
    expect((await fakeVectorStore('clip').query(vec(0), { topK: 10 })).map((m) => m.id)).toEqual([keep]);
    expect((await fakeVectorStore('face').query(vec(0), { topK: 10 })).map((m) => m.id)).toEqual(['fk1']);
    expect(await count('SELECT count(*) AS n FROM vector_delete_queue')).toBe(0);
  });

  it('keeps a person whose remaining faces are hidden', async () => {
    const { a, keep, ownerId } = await seedPurgeable();
    await env.DB.prepare("UPDATE asset_faces SET is_visible = 0 WHERE id = 'fk1'").run();
    await env.DB.prepare("UPDATE asset_faces SET person_group_id = 'pg-gone' WHERE id = 'fk1'").run();
    await purgeAssets(env, [(await row(a))!], new Date('2026-03-01T00:00:00.000Z'));
    expect(keep).toBeTruthy();
    const groups = (await env.DB.prepare('SELECT person_group_id FROM people ORDER BY person_group_id').all<{ person_group_id: string }>()).results.map((r) => r.person_group_id);
    expect(groups).toContain('pg-gone');
    expect(ownerId).toBeTruthy();
  });

  it('an asset restored before the commit keeps its embedding, faces, people and vectors', async () => {
    const { a } = await seedPurgeable();
    const stale = (await row(a))!;
    await env.DB.prepare('UPDATE assets SET deleted_at = NULL WHERE id = ?1').bind(a).run();
    await purgeAssets(env, [stale], new Date('2026-03-01T00:00:00.000Z'));
    expect(await row(a)).not.toBeNull();
    expect(await count('SELECT count(*) AS n FROM smart_search WHERE asset_id = ?1', a)).toBe(1);
    expect(await count('SELECT count(*) AS n FROM asset_faces')).toBe(3);
    expect(await count('SELECT count(*) AS n FROM people')).toBe(2);
    expect(await count('SELECT count(*) AS n FROM asset_face_audit')).toBe(0);
    expect(await count('SELECT count(*) AS n FROM vector_delete_queue')).toBe(0);
    expect(await fakeVectorStore('clip').query(vec(0), { topK: 10 })).toHaveLength(2);
    expect(await fakeVectorStore('face').query(vec(0), { topK: 10 })).toHaveLength(3);
  });

  it('a failed Vectorize delete keeps the ids queued and the next purge run drains them', async () => {
    const { a } = await seedPurgeable();
    const broken = { ...env, TEST_FAKE_VECTORS: 'false', CLIP_INDEX: { deleteByIds: async () => { throw new Error('vectorize down'); } }, FACE_INDEX: undefined } as unknown as Env;
    await expect(purgeAssets(broken, [(await row(a))!], new Date('2026-03-01T00:00:00.000Z'))).rejects.toThrow('vectorize down');
    expect(await row(a)).toBeNull();
    expect(await count("SELECT count(*) AS n FROM vector_delete_queue WHERE index_name = 'clip'")).toBe(1);
    expect(await count("SELECT count(*) AS n FROM vector_delete_queue WHERE index_name = 'face'")).toBe(2);
    const { purgeTrash } = await import('../src/cron/purge');
    await purgeTrash(env, new Date('2026-03-01T00:00:00.000Z'));
    expect(await count('SELECT count(*) AS n FROM vector_delete_queue')).toBe(0);
    expect((await fakeVectorStore('clip').query(vec(0), { topK: 10 })).map((m) => m.id)).not.toContain(a);
    expect((await fakeVectorStore('face').query(vec(0), { topK: 10 })).map((m) => m.id)).toEqual(['fk1']);
  });

  it('purging a deleted user removes their embeddings, faces, people, groups, thumbnails and vectors', async () => {
    const { token, ownerId } = await setup();
    const bob = await createUser({ email: 'bob@example.com', isAdmin: false });
    const bobToken = await login('bob@example.com');
    const b = await asset(bobToken, { mlAt: '2026-01-01T00:00:00.000Z', embedded: true });
    await face(b, bob.id, 'bf1', 'bpg');
    await person(bob.id, 'bpg', 'bf1');
    await person(bob.id, 'bpg-empty');
    await env.MEDIA.put('people/bpg.jpeg', 'x');
    await env.MEDIA.put('people/bpg-empty.jpeg', 'x');
    await fakeVectorStore('clip').upsert([{ id: b, values: vec(0), metadata: { ownerId: bob.id } }]);
    await fakeVectorStore('face').upsert([{ id: 'bf1', values: vec(0), namespace: bob.id }]);
    expect((await call(token, 'DELETE', `/admin/users/${bob.id}`, { force: true })).status).toBe(200);
    expect(ownerId).not.toBe(bob.id);
    expect(await purgeDeletedUsers(env)).toBe(1);
    expect(await count('SELECT count(*) AS n FROM smart_search')).toBe(0);
    expect(await count('SELECT count(*) AS n FROM asset_faces')).toBe(0);
    expect(await count('SELECT count(*) AS n FROM person_groups')).toBe(0);
    expect(await count('SELECT count(*) AS n FROM asset_face_audit WHERE face_id = ?1', 'bf1')).toBe(1);
    expect(await env.MEDIA.head('people/bpg.jpeg')).toBeNull();
    expect(await env.MEDIA.head('people/bpg-empty.jpeg')).toBeNull();
    expect(await fakeVectorStore('clip').query(vec(0), { topK: 10 })).toHaveLength(0);
    expect(await fakeVectorStore('face').query(vec(0), { topK: 10 })).toHaveLength(0);
    expect(await count('SELECT count(*) AS n FROM vector_delete_queue')).toBe(0);
  });
});

describe('server features', () => {
  it('report smart search, facial recognition, duplicate detection and reverse geocoding when the bindings exist', async () => {
    const res = await SELF.fetch(`${BASE}/api/server/features`);
    const f = (await res.json()) as Record<string, boolean>;
    expect(f).toMatchObject({ smartSearch: true, facialRecognition: true, duplicateDetection: true, reverseGeocoding: true });
  });

  it('report false without the ML container', async () => {
    const { serverRoutes } = await import('../src/server/routes');
    const bare = { ...env, ML_CONTAINER: undefined } as unknown as Env;
    const res = await serverRoutes.request('/server/features', {}, bare);
    const f = (await res.json()) as Record<string, boolean>;
    expect(f).toMatchObject({ smartSearch: false, facialRecognition: false, duplicateDetection: false, reverseGeocoding: true });
  });
});
