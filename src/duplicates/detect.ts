// Phase 4 Task C: duplicate detection, a port of Immich's handleSearchDuplicates over Vectorize and D1.
import { commit, tracked, type Tracked } from '../db/changes';
import type { AssetRow } from '../db/rows';
import { getSystemConfig } from '../config/store';
import { fromBlob } from '../ml/contract';
import { vectorStore } from '../ml/vectors';

/** Immich's DUPLICATE_SEARCH_LIMIT. */
export const CANDIDATES = 64;
/** Vectorize makes writes visible after a few seconds; assets younger than this wait for the next run. */
export const VISIBILITY_DELAY_MS = 60_000;

export interface DetectResult {
  /** Assets examined in this run. */
  checked: number;
  /** Assets whose group membership was written (own or merged). */
  grouped: number;
}

const IN_CHUNK = 90;
const json = (v: unknown) => JSON.stringify(v);

const assetGroup = (id: string, ownerId: string, duplicateId: string | null, now: string): Tracked =>
  tracked('UPDATE assets SET duplicate_id = ?2, updated_at = ?3, update_id = :cursor WHERE id = ?1 AND owner_id = ?4', id, duplicateId, now, ownerId);

async function commitChunks(db: D1Database, items: Array<Tracked | D1PreparedStatement>): Promise<void> {
  for (let i = 0; i < items.length; i += 100) await commit(db, items.slice(i, i + 100));
}

async function stampChecked(db: D1Database, ids: string[], now: string): Promise<void> {
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    await db.prepare('UPDATE assets SET duplicates_checked_at = ?2 WHERE id IN (SELECT value FROM json_each(?1))').bind(json(ids.slice(i, i + IN_CHUNK)), now).run();
  }
}

/**
 * Checks up to `limit` of the owner's assets that have an embedding, no duplicate check yet, and an ML stamp older than
 * 60 s. Each asset is compared with its nearest neighbours of the same owner and type; groups are linked through
 * `assets.duplicate_id` and merged when a new asset bridges two groups.
 */
export async function detectDuplicates(env: Env, ownerId: string, limit: number): Promise<DetectResult> {
  const result: DetectResult = { checked: 0, grouped: 0 };
  const store = vectorStore(env, 'clip');
  if (!store) return result;
  const config = await getSystemConfig(env.DB);
  const settings = config.machineLearning;
  if (!settings.enabled || !settings.duplicateDetection.enabled) return result;
  const maxDistance = settings.duplicateDetection.maxDistance;

  const cutoff = new Date(Date.now() - VISIBILITY_DELAY_MS).toISOString();
  const { results: pending } = await env.DB.prepare(
    `SELECT a.id FROM assets a JOIN smart_search s ON s.asset_id = a.id
     WHERE a.owner_id = ?1 AND a.status = 'ready' AND a.deleted_at IS NULL AND a.visibility IN ('timeline', 'archive')
       AND a.duplicates_checked_at IS NULL AND a.ml_at IS NOT NULL AND a.ml_at < ?2
     ORDER BY a.ml_at, a.id LIMIT ?3`,
  )
    .bind(ownerId, cutoff, limit)
    .all<{ id: string }>();

  for (const { id } of pending) {
    // Earlier assets in this run may have changed or stamped this one.
    const asset = await env.DB.prepare('SELECT * FROM assets WHERE id = ?1').bind(id).first<AssetRow>();
    if (!asset || asset.deleted_at !== null || asset.duplicates_checked_at !== null) continue;
    result.checked++;
    const now = new Date().toISOString();
    if (asset.stack_id !== null) {
      await stampChecked(env.DB, [id], now);
      continue;
    }
    const blob = await env.DB.prepare('SELECT embedding FROM smart_search WHERE asset_id = ?1').bind(id).first<ArrayBuffer>('embedding');
    if (!blob) continue;

    const matches = await store.query(fromBlob(blob), { topK: CANDIDATES, filter: { ownerId } });
    const near = new Map<string, number>();
    for (const m of matches) if (m.id !== id && 1 - m.score <= maxDistance) near.set(m.id, 1 - m.score);

    // D1 is the authority: same owner and type, not trashed, not stacked, default visibility.
    const found: Array<{ id: string; duplicate_id: string | null }> = [];
    const ids = [...near.keys()];
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      const { results } = await env.DB.prepare(
        `SELECT id, duplicate_id FROM assets WHERE id IN (SELECT value FROM json_each(?1)) AND owner_id = ?2 AND type = ?3
           AND deleted_at IS NULL AND stack_id IS NULL AND visibility IN ('timeline', 'archive')`,
      )
        .bind(json(ids.slice(i, i + IN_CHUNK)), ownerId, asset.type)
        .all<{ id: string; duplicate_id: string | null }>();
      found.push(...results);
    }

    const writes: Array<Tracked | D1PreparedStatement> = [];
    let touched = [id];
    if (found.length > 0) {
      const groupIds = [...new Set(found.map((f) => f.duplicate_id).filter((g): g is string => g !== null))];
      const target = asset.duplicate_id ?? groupIds.shift() ?? crypto.randomUUID();
      const sources = groupIds.filter((g) => g !== target);
      const update = new Set<string>([id, ...found.filter((f) => f.duplicate_id !== target).map((f) => f.id)]);
      for (let i = 0; i < sources.length; i += IN_CHUNK) {
        const { results } = await env.DB.prepare('SELECT id FROM assets WHERE owner_id = ?2 AND duplicate_id IN (SELECT value FROM json_each(?1))')
          .bind(json(sources.slice(i, i + IN_CHUNK)), ownerId)
          .all<{ id: string }>();
        for (const r of results) update.add(r.id);
      }
      touched = [...update];
      for (const uid of update) writes.push(assetGroup(uid, ownerId, target, now));
      result.grouped += update.size;
    } else if (asset.duplicate_id !== null) {
      writes.push(assetGroup(id, ownerId, null, now));
    }
    await commitChunks(env.DB, writes);
    await stampChecked(env.DB, touched, now);
  }
  return result;
}
