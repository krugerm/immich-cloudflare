import { requeueMissingBackups } from '../backup/consumer';
import { containerProcessor } from '../container/client';
import { cleanupMemories, generateMemories } from '../memories/generate';
import { DUPLICATE_CAP, startMlQueue, enqueueMlPending, runDuplicateDetection, runPlacesBackfill } from '../jobs/ml'; // phase 4 G
import type { ProcessMessage } from '../upload/routes';
import { cleanupLoginFailures, purgeTrash } from './purge';
import { purgeDeletedUsers, purgeExpiredSessions } from './purge-users';

const STALE_PENDING_MS = 60 * 60 * 1000;
const REQUEUE_CAP = 5000;
const SEND_CHUNK = 100;

/** Re-enqueues processing for assets that have sat in 'pending' for over an hour (lost message or exhausted retries). */
export async function requeueStalePending(env: Env, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_PENDING_MS).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT id FROM assets WHERE status = 'pending' AND created_at < ?1 AND deleted_at IS NULL ORDER BY created_at LIMIT ?2`,
  )
    .bind(cutoff, REQUEUE_CAP)
    .all<{ id: string }>();
  for (let i = 0; i < results.length; i += SEND_CHUNK) {
    const chunk = results.slice(i, i + SEND_CHUNK);
    await env.PROCESS_QUEUE.sendBatch(chunk.map((r) => ({ body: { assetId: r.id } satisfies ProcessMessage })));
  }
  return results.length;
}

const NEEDS_MEDIA_CAP = 200;

/** Re-enqueues assets waiting for the media container, oldest first. Does nothing until the container is usable. */
export async function requeueNeedsMedia(env: Env): Promise<number> {
  if (!containerProcessor(env)) return 0;
  const { results } = await env.DB.prepare(
    `SELECT id FROM assets WHERE status = 'needs_media' AND deleted_at IS NULL ORDER BY created_at, id LIMIT ?1`,
  )
    .bind(NEEDS_MEDIA_CAP)
    .all<{ id: string }>();
  for (let i = 0; i < results.length; i += SEND_CHUNK) {
    const chunk = results.slice(i, i + SEND_CHUNK);
    await env.PROCESS_QUEUE.sendBatch(chunk.map((r) => ({ body: { assetId: r.id } satisfies ProcessMessage })));
  }
  return results.length;
}

export const DAILY_CRON = '17 3 * * *';
export const WEEKLY_CRON = '41 4 * * SUN';
export const HANDLED_CRONS = [DAILY_CRON, WEEKLY_CRON];

type Step = [name: string, run: (env: Env) => Promise<unknown>];

const DAILY_STEPS: Step[] = [
  ['purgeTrash', (env) => purgeTrash(env)],
  ['cleanupLoginFailures', (env) => cleanupLoginFailures(env.DB)],
  ['requeueStalePending', (env) => requeueStalePending(env)],
  ['requeueNeedsMedia', (env) => requeueNeedsMedia(env)],
  ['cleanupMemories', (env) => cleanupMemories(env)], // stream F
  ['generateMemories', (env) => generateMemories(env)], // stream F
  ['purgeDeletedUsers', (env) => purgeDeletedUsers(env)], // stream A
  ['purgeExpiredSessions', (env) => purgeExpiredSessions(env)], // stream A
  ['enqueueMlPending', (env) => enqueueMlPending(env)], // phase 4 G
  ['detectDuplicates', (env) => runDuplicateDetection(env, DUPLICATE_CAP)], // phase 4 G
  ['recognizeFaces', (env) => startMlQueue(env, 'facialRecognition', false, 4000)], // phase 4 G: unassigned faces to the ClusterHub
  ['backfillPlaces', (env) => runPlacesBackfill(env)], // phase 4 G
];

/** Runs every step even when an earlier one throws; failures are logged and retried at the next run. */
async function runSteps(env: Env, steps: Step[]): Promise<void> {
  for (const [name, run] of steps) {
    try {
      await run(env);
    } catch (err) {
      console.error(`cron step ${name} failed`, err);
    }
  }
}

export async function runScheduled(cron: string, env: Env): Promise<void> {
  if (cron === DAILY_CRON) await runSteps(env, DAILY_STEPS);
  if (cron === WEEKLY_CRON) await runSteps(env, [['requeueMissingBackups', (e) => requeueMissingBackups(e)]]);
}
