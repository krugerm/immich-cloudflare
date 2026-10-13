// stream F: admin queue and job endpoints. Background work runs on Cloudflare Queues; state is derived from asset rows.
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { requireAdmin } from '../auth/session';
import { requeueMissingBackups } from '../backup/consumer';
import { ImmichError } from '../http/errors';
import { bad, jsonObject } from '../http/validate';
import { cleanupMemories, generateMemories } from '../memories/generate';
import { deleteState, getState, setState } from '../server/state';
import type { ProcessMessage } from '../upload/routes';
import { isMlQueue, mlStats, startMlQueue } from './ml'; // phase 4 G

export const jobRoutes = new Hono<AppEnv>();

export const QUEUE_NAMES = [
  'thumbnailGeneration', 'metadataExtraction', 'videoConversion', 'faceDetection', 'facialRecognition', 'smartSearch',
  'duplicateDetection', 'backgroundTask', 'storageTemplateMigration', 'migration', 'search', 'sidecar', 'library',
  'notifications', 'backupDatabase', 'ocr', 'workflow', 'integrityCheck', 'editor',
];
const PROCESS_QUEUES: Record<string, string> = { thumbnailGeneration: 'AssetGenerateThumbnails', metadataExtraction: 'AssetExtractMetadata' };
// Queues whose feature does not exist here: `start` is accepted and does nothing (Immich accepts it for these too).
const NOOP_START = new Set([
  'videoConversion', 'sidecar', 'library', 'ocr',
  'storageTemplateMigration', 'migration',
]);
const COMMANDS = ['start', 'pause', 'resume', 'empty', 'clear-failed'];
const JOB_STATUSES = ['active', 'failed', 'completed', 'delayed', 'waiting', 'paused'];
const MANUAL_JOBS = [
  'person-cleanup', 'tag-cleanup', 'user-cleanup', 'memory-cleanup', 'memory-create', 'backup-database', 'integrity-missing-files',
  'integrity-untracked-files', 'integrity-checksum-mismatch', 'integrity-missing-files-refresh', 'integrity-untracked-files-refresh',
  'integrity-checksum-mismatch-refresh', 'integrity-missing-files-delete-all', 'integrity-untracked-files-delete-all',
  'integrity-checksum-mismatch-delete-all',
];
const START_CAP = 4000; // per start; repeated starts continue from a stored cursor
const LIST_CAP = 1000;
const PAUSED_KEY = 'queue_paused';

interface Stats { active: number; completed: number; failed: number; delayed: number; waiting: number; paused: number }
const stats = (o: Partial<Stats> = {}): Stats => ({ active: 0, completed: 0, failed: 0, delayed: 0, waiting: 0, paused: 0, ...o });

function queueName(c: { req: { param(k: string): string } }): string {
  const name = c.req.param('name');
  if (!QUEUE_NAMES.includes(name)) bad('Invalid queue name');
  return name;
}

async function pausedMap(db: D1Database): Promise<Record<string, boolean>> {
  return (await getState<Record<string, boolean>>(db, PAUSED_KEY)) ?? {};
}

async function allStats(env: Env): Promise<Record<string, Stats>> {
  const r = await env.DB
    .prepare(
      `SELECT coalesce(sum(status IN ('pending', 'needs_media')), 0) AS pending, coalesce(sum(status = 'failed'), 0) AS failed,
         coalesce(sum(status = 'ready'), 0) AS ready, coalesce(sum(backed_up_at IS NULL AND status <> 'pending'), 0) AS unbacked,
         coalesce(sum(backed_up_at IS NOT NULL), 0) AS backed
       FROM assets WHERE deleted_at IS NULL`,
    )
    .first<{ pending: number; failed: number; ready: number; unbacked: number; backed: number }>();
  const ml = await mlStats(env); // phase 4 G
  const process = stats({ waiting: r!.pending, failed: r!.failed, completed: r!.ready });
  return Object.fromEntries(
    QUEUE_NAMES.map((n) => [n, n in PROCESS_QUEUES ? process : n === 'backupDatabase' ? stats({ waiting: r!.unbacked, completed: r!.backed }) : isMlQueue(n) ? ml[n] : stats()]),
  );
}

async function queueState(env: Env, name: string) {
  const [all, paused] = await Promise.all([allStats(env), pausedMap(env.DB)]);
  return { name, isPaused: paused[name] === true, statistics: all[name] };
}

const legacy = (q: { isPaused: boolean; statistics: Stats }) => ({
  queueStatus: { isPaused: q.isPaused, isActive: q.statistics.active > 0 },
  jobCounts: q.statistics,
});

async function setPaused(db: D1Database, name: string, value: boolean) {
  const map = await pausedMap(db);
  if (value) map[name] = true;
  else delete map[name];
  await setState(db, PAUSED_KEY, map);
}

async function enqueue(env: Env, ids: string[], force: boolean): Promise<void> {
  for (let i = 0; i < ids.length; i += 100) {
    await env.PROCESS_QUEUE.sendBatch(ids.slice(i, i + 100).map((assetId) => ({ body: (force ? { assetId, force: true } : { assetId }) satisfies ProcessMessage })));
  }
}

async function startQueue(env: Env, name: string, force: boolean): Promise<void> {
  if (name in PROCESS_QUEUES) {
    const key = `start_cursor:${name}:${force ? 'all' : 'missing'}`;
    const cursor = (await getState<string>(env.DB, key)) ?? '';
    const where = force ? '' : "AND status IN ('pending', 'failed', 'needs_media')";
    const { results } = await env.DB
      .prepare(`SELECT id FROM assets WHERE deleted_at IS NULL AND id > ?1 ${where} ORDER BY id LIMIT ?2`)
      .bind(cursor, START_CAP)
      .all<{ id: string }>();
    await enqueue(env, results.map((r) => r.id), force);
    // A full batch means there may be more: the next start continues after the last id. A short batch resets the cursor.
    if (results.length === START_CAP) await setState(env.DB, key, results[results.length - 1].id);
    else await deleteState(env.DB, key);
  } else if (name === 'backupDatabase') {
    await requeueMissingBackups(env);
  } else if (isMlQueue(name)) {
    await startMlQueue(env, name, force, START_CAP); // phase 4 G
  } else if (!NOOP_START.has(name)) {
    bad(`Invalid job name: ${name}`);
  }
}

jobRoutes.get('/queues', requireAdmin, async (c) => {
  const [all, paused] = await Promise.all([allStats(c.env), pausedMap(c.env.DB)]);
  return c.json(QUEUE_NAMES.map((name) => ({ name, isPaused: paused[name] === true, statistics: all[name] })));
});

jobRoutes.get('/queues/:name', requireAdmin, async (c) => c.json(await queueState(c.env, queueName(c))));

jobRoutes.put('/queues/:name', requireAdmin, async (c) => {
  const name = queueName(c);
  const body = await jsonObject(c.req.raw);
  if (body.isPaused !== undefined && typeof body.isPaused !== 'boolean') bad('isPaused must be a boolean');
  if (body.isPaused === true && name === 'backgroundTask') bad('The BackgroundTask queue cannot be paused');
  if (typeof body.isPaused === 'boolean') await setPaused(c.env.DB, name, body.isPaused);
  return c.json(await queueState(c.env, name));
});

// Jobs are asset rows: waiting = pending or needs_media, failed = failed, completed = ready. Without a status filter, completed jobs are omitted.
jobRoutes.get('/queues/:name/jobs', requireAdmin, async (c) => {
  const name = queueName(c);
  const statuses = c.req.queries('status') ?? ['active', 'failed', 'delayed', 'waiting', 'paused'];
  if (statuses.some((s) => !JOB_STATUSES.includes(s))) bad(`status must be one of: ${JOB_STATUSES.join(', ')}`);
  const jobName = PROCESS_QUEUES[name];
  const assetStatus = statuses.flatMap((s) => (s === 'waiting' ? ['pending', 'needs_media'] : s === 'failed' ? ['failed'] : s === 'completed' ? ['ready'] : []));
  if (!jobName || assetStatus.length === 0) return c.json([]);
  const { results } = await c.env.DB
    .prepare(`SELECT id, created_at FROM assets WHERE deleted_at IS NULL AND status IN (${assetStatus.map((_, i) => `?${i + 1}`).join(',')}) ORDER BY created_at LIMIT ${LIST_CAP}`)
    .bind(...assetStatus)
    .all<{ id: string; created_at: string }>();
  return c.json(results.map((r) => ({ id: r.id, name: jobName, data: { id: r.id }, timestamp: Date.parse(r.created_at) })));
});

// Messages in a Cloudflare Queue cannot be removed from a Worker, and failed state lives on the asset row: accepted, nothing to do.
jobRoutes.delete('/queues/:name/jobs', requireAdmin, async (c) => {
  queueName(c);
  const body = await c.req.json().catch(() => ({}));
  if (typeof body !== 'object' || body === null || Array.isArray(body)) bad('Request body must be a JSON object');
  if ((body as { failed?: unknown }).failed !== undefined && typeof (body as { failed?: unknown }).failed !== 'boolean') bad('failed must be a boolean');
  return c.body(null, 204);
});

jobRoutes.get('/jobs', requireAdmin, async (c) => {
  const [all, paused] = await Promise.all([allStats(c.env), pausedMap(c.env.DB)]);
  return c.json(Object.fromEntries(QUEUE_NAMES.map((n) => [n, legacy({ isPaused: paused[n] === true, statistics: all[n] })])));
});

jobRoutes.put('/jobs/:name', requireAdmin, async (c) => {
  const name = queueName(c);
  const body = await jsonObject(c.req.raw);
  if (typeof body.command !== 'string' || !COMMANDS.includes(body.command)) bad(`command must be one of: ${COMMANDS.join(', ')}`);
  if (body.force !== undefined && typeof body.force !== 'boolean') bad('force must be a boolean');
  switch (body.command) {
    case 'start':
      // Pause only blocks starts: messages already in the Cloudflare Queue are not held back.
      if (!(await pausedMap(c.env.DB))[name]) await startQueue(c.env, name, body.force === true);
      break;
    case 'pause':
      await setPaused(c.env.DB, name, true);
      break;
    case 'resume':
      await setPaused(c.env.DB, name, false);
      break;
    // empty, clear-failed: nothing removable, see DELETE /queues/:name/jobs
  }
  return c.json(legacy(await queueState(c.env, name)));
});

jobRoutes.post('/jobs', requireAdmin, async (c) => {
  const { name } = await jsonObject(c.req.raw);
  if (typeof name !== 'string' || !MANUAL_JOBS.includes(name)) throw new ImmichError(400, 'Invalid job name');
  if (name === 'backup-database') await requeueMissingBackups(c.env);
  else if (name === 'memory-create') await generateMemories(c.env);
  else if (name === 'memory-cleanup') await cleanupMemories(c.env);
  // person/tag/user cleanup and integrity jobs have nothing to do here.
  return c.body(null, 204);
});
