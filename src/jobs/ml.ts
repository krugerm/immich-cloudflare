// Phase 4 Task G: admin start/force for the ML queues, their statistics, and the daily cron steps.
// State lives in D1 (assets.ml_at, smart_search, assets.duplicates_checked_at, asset_faces); the work runs on the
// `asset-ml` queue (see src/ml/job.ts) or in the duplicate and cluster passes.
import { ImmichError } from '../http/errors';
import { commit } from '../db/changes';
import { deleteQueuedVectors, mlPurgeItems } from './ml-purge';
import { deleteState, getState, setState } from '../server/state';
import type { MlMessage } from '../ml/job';
import { detectDuplicates } from '../duplicates/detect';
import { clusterStatus, requestClustering, type ClusterStatus } from '../faces/cluster';
import { backfillPlaces } from '../geo/backfill';

export const ML_QUEUE_NAMES = ['smartSearch', 'faceDetection', 'facialRecognition', 'duplicateDetection'] as const;
export type MlQueueName = (typeof ML_QUEUE_NAMES)[number];
export const isMlQueue = (name: string): name is MlQueueName => (ML_QUEUE_NAMES as readonly string[]).includes(name);

export interface QueueStats { active: number; completed: number; failed: number; delayed: number; waiting: number; paused: number }

/**
 * Functions owned by other phase 4 streams, called through this table so the merge is a one-line swap each and tests
 * can stub them. Each returns how many assets it processed.
 */
export const mlHooks: {
  detectDuplicates(env: Env, ownerId: string, limit: number): Promise<number | void>;
  backfillPlaces(env: Env, limit: number): Promise<number | void>;
} = {
  detectDuplicates: async (env, ownerId, limit) => (await detectDuplicates(env, ownerId, limit)).checked,
  // backfillPlaces pages with a cursor (ocean points keep a null city and would be re-read from the start)
  backfillPlaces: async (env, limit) => {
    let done = 0;
    let after = '';
    while (done < limit) {
      const page = await backfillPlaces(env, Math.min(500, limit - done), after);
      done += page.processed;
      if (!page.next) break;
      after = page.next;
    }
    return done;
  },
};

const SEND_CHUNK = 100;
export const ML_PENDING_CAP = 500;
// Per invocation, so the D1 queries stay well under 1,000 per invocation (detectDuplicates costs about 5 per asset,
// backfillPlaces about 2 per GPS asset); the daily cron and repeated admin starts continue from where they stopped.
export const DUPLICATE_CAP = 150;
export const PLACES_CAP = 300;

async function sendMl(env: Env, messages: MlMessage[]): Promise<void> {
  if (!env.ML_QUEUE) return;
  for (let i = 0; i < messages.length; i += SEND_CHUNK) {
    await env.ML_QUEUE.sendBatch(messages.slice(i, i + SEND_CHUNK).map((body) => ({ body })));
  }
}

/** Reads the next page after a stored cursor; a full page keeps the cursor, a short one resets it (like the process queues). */
async function page<T extends { id: string }>(env: Env, key: string, cap: number, read: (cursor: string) => Promise<T[]>): Promise<T[]> {
  const cursor = (await getState<string>(env.DB, key)) ?? '';
  const rows = await read(cursor);
  if (rows.length === cap) await setState(env.DB, key, rows[rows.length - 1].id);
  else await deleteState(env.DB, key);
  return rows;
}

const READY = "status = 'ready' AND deleted_at IS NULL";

async function startSmartSearch(env: Env, force: boolean, cap: number): Promise<void> {
  const where = force ? '' : 'AND NOT EXISTS (SELECT 1 FROM smart_search s WHERE s.asset_id = assets.id)';
  const rows = await page(env, `start_cursor:smartSearch:${force ? 'all' : 'missing'}`, cap, async (cursor) =>
    (await env.DB.prepare(`SELECT id, ml_at FROM assets WHERE ${READY} AND id > ?1 ${where} ORDER BY id LIMIT ?2`).bind(cursor, cap).all<{ id: string; ml_at: string | null }>()).results,
  );
  // An asset the ML job never ran for gets faces too, so one pass stamps ml_at with both parts done.
  await sendMl(env, rows.map((r) => ({ assetId: r.id, clip: true, faces: r.ml_at === null, force: true })));
}

const RESET_BATCH = 25;

/**
 * Forced detection starts clean: the assets' machine-learning faces are hard-deleted (audit rows, vector ids queued,
 * people left without faces removed) in the same commit, so the next detection inserts fresh faces. Manual and exif faces stay.
 */
async function resetMachineFaces(env: Env, ids: string[]): Promise<void> {
  const now = new Date().toISOString();
  for (let i = 0; i < ids.length; i += RESET_BATCH) {
    const chunk = ids.slice(i, i + RESET_BATCH);
    const guard = (id: string) => ({ sql: (p: string) => `EXISTS (SELECT 1 FROM assets WHERE id = ${p} AND deleted_at IS NULL)`, value: id });
    const items = await mlPurgeItems(env, chunk.map((id) => ({ id, owner_id: '' })), now, guard, true);
    // ml_at cleared in the same commit: if the re-queue below fails, the daily cron picks the assets up again
    items.push(env.DB.prepare('UPDATE assets SET ml_at = NULL WHERE id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(chunk)));
    await commit(env.DB, items);
  }
  await deleteQueuedVectors(env);
}

async function startFaceDetection(env: Env, force: boolean, cap: number): Promise<void> {
  // Refuse before any face is deleted: without the queue and the ML client nothing would regenerate them.
  if (force && (!env.ML_QUEUE || !env.ML_CONTAINER)) throw new ImmichError(400, 'Machine learning is not configured; faces were not reset');
  const where = force ? '' : 'AND ml_at IS NULL';
  const rows = await page(env, `start_cursor:faceDetection:${force ? 'all' : 'missing'}`, cap, async (cursor) =>
    (await env.DB.prepare(`SELECT id FROM assets WHERE ${READY} AND id > ?1 ${where} ORDER BY id LIMIT ?2`).bind(cursor, cap).all<{ id: string }>()).results,
  );
  if (force && rows.length) {
    await resetMachineFaces(env, rows.map((r) => r.id));
  }
  // Never-processed assets get both parts, otherwise ml_at would be stamped without an embedding.
  await sendMl(env, rows.map((r) => (force ? { assetId: r.id, clip: false, faces: true, force: true } : { assetId: r.id })));
}

/** Clustering per cluster group; the hub resets machine assignments once on `force` and continues across alarms. */
export const mlCluster: {
  requestClustering(env: Env, clusterGroupId: string, opts: { force: boolean }): Promise<void>;
  clusterStatus(env: Env, clusterGroupId: string): Promise<ClusterStatus>;
} = {
  requestClustering,
  clusterStatus,
};

/** One request per cluster group that has unassigned machine faces; a forced run covers every group with machine faces. */
export async function startFacialRecognition(env: Env, force: boolean): Promise<void> {
  const where = force ? '' : 'AND person_group_id IS NULL';
  const { results } = await env.DB
    .prepare(`SELECT DISTINCT cluster_group_id FROM asset_faces WHERE source_type = 'machine-learning' AND deleted_at IS NULL AND is_visible = 1 ${where} ORDER BY cluster_group_id`)
    .all<{ cluster_group_id: string }>();
  for (const r of results) await mlCluster.requestClustering(env, r.cluster_group_id, { force });
}

/** Runs duplicate detection over assets that have an embedding and no check yet, owner by owner, within `limit`. */
export async function runDuplicateDetection(env: Env, limit: number): Promise<void> {
  const { results: owners } = await env.DB.prepare(
    `SELECT DISTINCT owner_id FROM assets WHERE ${READY} AND duplicates_checked_at IS NULL AND EXISTS (SELECT 1 FROM smart_search s WHERE s.asset_id = assets.id) ORDER BY owner_id`,
  ).all<{ owner_id: string }>();
  let remaining = limit;
  for (const o of owners) {
    if (remaining <= 0) break;
    const done = await mlHooks.detectDuplicates(env, o.owner_id, remaining);
    remaining = typeof done === 'number' ? remaining - done : 0; // an unreported count counts as the whole budget
  }
}

/** Message on the asset-ml queue that runs the next batch of an admin-started duplicate run. */
export interface DuplicateRunMessage {
  duplicateRun: string;
}

interface DuplicateRun {
  id: string;
  /** When the last batch finished; a run with no batch for DUPLICATE_RUN_STALE_MS died (its retries ran out). */
  at: string;
}

const DUPLICATE_RUN_KEY = 'duplicate_run';
const DUPLICATE_RUN_STALE_MS = 10 * 60_000;

async function duplicateBacklog(db: D1Database): Promise<number> {
  return (
    (await db
      .prepare(`SELECT count(*) AS n FROM assets WHERE ${READY} AND duplicates_checked_at IS NULL AND EXISTS (SELECT 1 FROM smart_search s WHERE s.asset_id = assets.id)`)
      .first<number>('n')) ?? 0
  );
}

/** Queues the next batch while assets are left and the last batch made progress; otherwise ends the run. */
async function chainDuplicateRun(env: Env, id: string, before: number): Promise<void> {
  const left = await duplicateBacklog(env.DB);
  if (left === 0 || left >= before || !env.ML_QUEUE) return deleteState(env.DB, DUPLICATE_RUN_KEY);
  await setState(env.DB, DUPLICATE_RUN_KEY, { id, at: new Date().toISOString() } satisfies DuplicateRun);
  await env.ML_QUEUE.send({ duplicateRun: id } satisfies DuplicateRunMessage);
}

/** One batch of a duplicate run, from the asset-ml consumer. A message of a superseded or finished run is dropped. */
export async function continueDuplicateRun(env: Env, id: string): Promise<void> {
  const run = await getState<DuplicateRun>(env.DB, DUPLICATE_RUN_KEY);
  if (run?.id !== id) return;
  const before = await duplicateBacklog(env.DB);
  await runDuplicateDetection(env, DUPLICATE_CAP);
  await chainDuplicateRun(env, id, before);
}

/**
 * The first batch runs in the request; the rest continue on the asset-ml queue, one DUPLICATE_CAP batch per message,
 * so one click checks every asset. A new start supersedes the run in progress.
 */
async function startDuplicateDetection(env: Env, force: boolean): Promise<void> {
  // duplicates_checked_at is not in any sync payload, so a plain statement is enough
  if (force) await env.DB.prepare(`UPDATE assets SET duplicates_checked_at = NULL WHERE ${READY} AND duplicates_checked_at IS NOT NULL`).run();
  const id = crypto.randomUUID();
  await setState(env.DB, DUPLICATE_RUN_KEY, { id, at: new Date().toISOString() } satisfies DuplicateRun);
  const before = await duplicateBacklog(env.DB);
  await runDuplicateDetection(env, DUPLICATE_CAP);
  await chainDuplicateRun(env, id, before);
}

export async function startMlQueue(env: Env, name: MlQueueName, force: boolean, cap: number): Promise<void> {
  if (name === 'smartSearch') return startSmartSearch(env, force, cap);
  if (name === 'faceDetection') return startFaceDetection(env, force, cap);
  if (name === 'facialRecognition') return startFacialRecognition(env, force);
  return startDuplicateDetection(env, force);
}

const stats = (o: Partial<QueueStats>): QueueStats => ({ active: 0, completed: 0, failed: 0, delayed: 0, waiting: 0, paused: 0, ...o });

/** Sum of the cluster hubs' queues; a hub that cannot be reached counts as idle. */
async function clusteringStats(env: Env): Promise<{ active: number; waiting: number }> {
  const { results } = await env.DB
    .prepare("SELECT DISTINCT cluster_group_id FROM asset_faces WHERE source_type = 'machine-learning' AND deleted_at IS NULL")
    .all<{ cluster_group_id: string }>();
  let active = 0;
  let waiting = 0;
  for (const r of results) {
    const s = await mlCluster.clusterStatus(env, r.cluster_group_id).catch(() => null);
    if (!s) continue;
    if (s.running || s.scanning || s.resetting || s.pending + s.deferred > 0) active = 1;
    waiting += s.pending + s.deferred;
  }
  return { active, waiting };
}

/**
 * Completed = work done, from D1 (deleted assets excluded). The web app shows a queue's start buttons only while
 * active + waiting is 0 and polls these numbers, so they describe work in progress: assets the ML job has still to run
 * for (normally on the asset-ml queue), faces the cluster hubs still hold, and the assets a live duplicate run has left.
 */
export async function mlStats(env: Env): Promise<Record<MlQueueName, QueueStats>> {
  const a = await env.DB
    .prepare(
      `SELECT coalesce(sum(ml_at IS NULL), 0) AS ml_waiting, coalesce(sum(ml_at IS NOT NULL), 0) AS ml_done,
         coalesce(sum(s.asset_id IS NOT NULL), 0) AS embedded,
         coalesce(sum(s.asset_id IS NOT NULL AND duplicates_checked_at IS NULL), 0) AS dup_waiting,
         coalesce(sum(s.asset_id IS NOT NULL AND duplicates_checked_at IS NOT NULL), 0) AS dup_done
       FROM assets LEFT JOIN smart_search s ON s.asset_id = assets.id WHERE assets.status = 'ready' AND assets.deleted_at IS NULL`,
    )
    .first<Record<string, number>>();
  const f = await env.DB
    .prepare(
      `SELECT coalesce(sum(person_group_id IS NOT NULL), 0) AS assigned
       FROM asset_faces WHERE source_type = 'machine-learning' AND deleted_at IS NULL AND is_visible = 1`,
    )
    .first<{ assigned: number }>();
  const run = await getState<DuplicateRun>(env.DB, DUPLICATE_RUN_KEY);
  const dupLive = run !== null && Date.now() - Date.parse(run.at) < DUPLICATE_RUN_STALE_MS;
  return {
    smartSearch: stats({ waiting: a!.ml_waiting, completed: a!.embedded }),
    faceDetection: stats({ waiting: a!.ml_waiting, completed: a!.ml_done }),
    facialRecognition: stats({ ...(await clusteringStats(env)), completed: f!.assigned }),
    duplicateDetection: stats({ active: dupLive ? 1 : 0, waiting: dupLive ? a!.dup_waiting : 0, completed: a!.dup_done }),
  };
}

/** Daily cron: queues ready assets the ML job has not run for (lost messages, exhausted retries, assets from before phase 4). */
export async function enqueueMlPending(env: Env, limit = ML_PENDING_CAP): Promise<number> {
  if (!env.ML_QUEUE) return 0;
  const { results } = await env.DB.prepare(`SELECT id FROM assets WHERE ${READY} AND ml_at IS NULL ORDER BY created_at, id LIMIT ?1`).bind(limit).all<{ id: string }>();
  await sendMl(env, results.map((r) => ({ assetId: r.id })));
  return results.length;
}

export const runPlacesBackfill = (env: Env, limit = PLACES_CAP) => mlHooks.backfillPlaces(env, limit);
