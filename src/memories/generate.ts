import { getState, setState } from '../server/state';
import { chunks, createMemory, deleteMemory, removeMemoryAssets } from './repo';

const DAYS = 3;
const ASSETS_PER_YEAR = 20;
const CLEANUP_AGE_DAYS = 30;
const STATE_KEY = 'memories_state';
const DAY_MS = 86_400_000;

const startOfDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/** Creates the missing memories of one user and day, at most `budget`. Returns how many were created and whether the day is done. */
async function createOnThisDayMemories(db: D1Database, ownerId: string, target: Date, budget: number): Promise<{ created: number; complete: boolean }> {
  const monthDay = target.toISOString().slice(5, 10);
  const targetYear = target.getUTCFullYear();
  const showAt = startOfDay(target).toISOString();
  const { results } = await db
    .prepare(
      `SELECT id, substr(local_date_time, 1, 4) AS year FROM assets
       WHERE owner_id = ?1 AND substr(local_date_time, 6, 5) = ?2 AND CAST(substr(local_date_time, 1, 4) AS INTEGER) < ?3
         AND visibility = 'timeline' AND deleted_at IS NULL AND has_thumbnail = 1
       ORDER BY local_date_time DESC`,
    )
    .bind(ownerId, monthDay, targetYear)
    .all<{ id: string; year: string }>();
  const byYear = new Map<number, string[]>();
  for (const r of results) {
    const list = byYear.get(Number(r.year)) ?? [];
    if (list.length < ASSETS_PER_YEAR) list.push(r.id);
    byYear.set(Number(r.year), list);
  }
  // Progress is whatever already exists: a rerun skips these, and the unique index stops a concurrent run from duplicating.
  const { results: existing } = await db
    .prepare("SELECT memory_at FROM memories WHERE owner_id = ?1 AND type = 'on_this_day' AND show_at = ?2")
    .bind(ownerId, showAt)
    .all<{ memory_at: string }>();
  const have = new Set(existing.map((e) => e.memory_at));
  const hideAt = new Date(startOfDay(target).getTime() + DAY_MS - 1).toISOString();
  let created = 0;
  for (const [year, assetIds] of [...byYear].sort((a, b) => b[0] - a[0])) {
    const memoryAt = `${String(year).padStart(4, '0')}-${monthDay}T00:00:00.000Z`;
    if (have.has(memoryAt)) continue;
    if (created >= budget) return { created, complete: false };
    const id = await createMemory(db, { ownerId, type: 'on_this_day', data: { year }, memoryAt, showAt, hideAt }, assetIds);
    if (id !== null) created++;
  }
  return { created, complete: true };
}

export const MEMORY_RUN_CAP = 100;

/**
 * Immich's MemoryGenerate: for each day from today-3 to today+3 that is past the stored state, creates "on this day"
 * memories for every user. At most `cap` memories are created per call; the stored day only advances once a day is
 * complete, so the next call continues where this one stopped. Birthday memories need people recognition, which this
 * server does not have.
 */
export async function generateMemories(env: Env, now = new Date(), opts: { cap?: number } = {}): Promise<number> {
  const db = env.DB;
  const cap = opts.cap ?? MEMORY_RUN_CAP;
  const { results: users } = await db.prepare('SELECT id FROM users WHERE deleted_at IS NULL ORDER BY id').all<{ id: string }>();
  const state = await getState<{ lastOnThisDayDate?: string }>(db, STATE_KEY);
  const start = new Date(startOfDay(now).getTime() - DAYS * DAY_MS);
  const last = state?.lastOnThisDayDate ? new Date(state.lastOnThisDayDate) : start;
  let created = 0;
  for (let i = 0; i <= DAYS * 2; i++) {
    const target = new Date(start.getTime() + i * DAY_MS);
    if (last.getTime() >= target.getTime()) continue;
    let complete = true;
    try {
      for (const u of users) {
        const r = await createOnThisDayMemories(db, u.id, target, cap - created);
        created += r.created;
        if (!r.complete) {
          complete = false;
          break;
        }
      }
    } catch (err) {
      console.error('memory generation failed', target.toISOString(), err);
    }
    if (!complete) break; // cap reached: resume this day on the next run
    // Stored even after an error, as Immich does, to avoid duplicates.
    await setState(db, STATE_KEY, { ...state, lastOnThisDayDate: target.toISOString() });
  }
  return created;
}

/** Immich's MemoryCleanup: drop assets that left the timeline, then unsaved memories older than 30 days. */
export async function cleanupMemories(env: Env, now = new Date()): Promise<void> {
  const db = env.DB;
  const { results: stale } = await db
    .prepare(
      `SELECT ma.memory_id, ma.asset_id, m.owner_id FROM memory_assets ma
       JOIN assets a ON a.id = ma.asset_id JOIN memories m ON m.id = ma.memory_id WHERE a.visibility <> 'timeline' LIMIT 2000`,
    )
    .all<{ memory_id: string; asset_id: string; owner_id: string }>();
  const byMemory = new Map<string, { owner: string; assets: string[] }>();
  for (const r of stale) {
    const e = byMemory.get(r.memory_id) ?? { owner: r.owner_id, assets: [] };
    e.assets.push(r.asset_id);
    byMemory.set(r.memory_id, e);
  }
  for (const [id, e] of byMemory) {
    for (const part of chunks(e.assets, 25)) await removeMemoryAssets(db, { id, owner_id: e.owner }, part);
  }
  const cutoff = new Date(now.getTime() - CLEANUP_AGE_DAYS * DAY_MS).toISOString();
  const { results: old } = await db
    .prepare('SELECT id, owner_id FROM memories WHERE created_at < ?1 AND is_saved = 0 LIMIT 1000')
    .bind(cutoff)
    .all<{ id: string; owner_id: string }>();
  for (const m of old) await deleteMemory(db, m);
}
