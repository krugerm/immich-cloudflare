import type { RowGuard } from '../albums/repo';
import { mapAssetResponse } from '../assets/map';
import { commit, tracked } from '../db/changes';
import type { AssetRow, ExifRow } from '../db/rows';
import type { Dto } from '../gen/dto';
import { ImmichError } from '../http/errors';

export interface MemoryRow {
  id: string;
  owner_id: string;
  type: 'on_this_day' | 'birthday';
  data: string;
  is_saved: number;
  memory_at: string;
  seen_at: string | null;
  show_at: string | null;
  hide_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  update_id: string;
}

export interface NewMemory {
  ownerId: string;
  type: 'on_this_day' | 'birthday';
  data: Record<string, unknown>;
  isSaved?: boolean;
  memoryAt: string;
  showAt?: string | null;
  hideAt?: string | null;
  seenAt?: string | null;
}

const CHUNK = 90;
export function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
const marks = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `?${i + from}`).join(',');

export function accessError(permission: string): ImmichError {
  return new ImmichError(400, `Not found or no ${permission} access`);
}

/** Owner-only access, as Immich's memory permissions grant. */
export async function requireMemory(db: D1Database, id: string, userId: string, permission: string): Promise<MemoryRow> {
  const m = await db.prepare('SELECT * FROM memories WHERE id = ?1 AND owner_id = ?2 AND deleted_at IS NULL').bind(id, userId).first<MemoryRow>();
  if (!m) throw accessError(permission);
  return m;
}

/** The subset of `ids` that are assets owned by `userId` (Immich's asset.update permission). */
export async function ownedAssetIds(db: D1Database, userId: string, ids: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (const part of chunks([...new Set(ids)])) {
    const { results } = await db.prepare(`SELECT id FROM assets WHERE owner_id = ?1 AND id IN (${marks(part.length, 2)})`).bind(userId, ...part).all<{ id: string }>();
    for (const r of results) found.add(r.id);
  }
  return found;
}

/** Timeline-visible, untrashed assets of each memory, ordered by file_created_at. */
export async function assetsByMemory(db: D1Database, memoryIds: string[]): Promise<Map<string, Dto<'AssetResponseDto'>[]>> {
  const out = new Map<string, Dto<'AssetResponseDto'>[]>(memoryIds.map((id) => [id, []]));
  for (const part of chunks(memoryIds)) {
    const { results } = await db
      .prepare(
        `SELECT a.*, ma.memory_id AS memory_id FROM memory_assets ma JOIN assets a ON a.id = ma.asset_id
         WHERE ma.memory_id IN (${marks(part.length)}) AND a.visibility = 'timeline' AND a.deleted_at IS NULL
         ORDER BY a.file_created_at, a.id`,
      )
      .bind(...part)
      .all<AssetRow & { memory_id: string }>();
    const exif = new Map<string, ExifRow>();
    for (const ids of chunks([...new Set(results.map((r) => r.id))])) {
      const ex = await db.prepare(`SELECT * FROM asset_exif WHERE asset_id IN (${marks(ids.length)})`).bind(...ids).all<ExifRow>();
      for (const e of ex.results) exif.set(e.asset_id, e);
    }
    for (const { memory_id, ...asset } of results) out.get(memory_id)!.push(mapAssetResponse(asset as AssetRow, exif.get(asset.id) ?? null));
  }
  return out;
}

export function mapMemory(m: MemoryRow, assets: Dto<'AssetResponseDto'>[]): Dto<'MemoryResponseDto'> {
  return {
    id: m.id,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
    deletedAt: m.deleted_at ?? undefined,
    memoryAt: m.memory_at,
    seenAt: m.seen_at ?? undefined,
    showAt: m.show_at ?? undefined,
    hideAt: m.hide_at ?? undefined,
    ownerId: m.owner_id,
    type: m.type,
    data: JSON.parse(m.data),
    isSaved: m.is_saved === 1,
    assets,
  };
}

/** Inserts a memory and its assets; returns null when the on-this-day unique key already exists (nothing is written). */
export async function createMemory(db: D1Database, input: NewMemory, assetIds: Iterable<string>): Promise<string | null> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const ids = [...new Set(assetIds)];
  await commit(db, [
    tracked(
      `INSERT OR IGNORE INTO memories (id, owner_id, type, data, is_saved, memory_at, seen_at, show_at, hide_at, created_at, updated_at, update_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, :cursor)`,
      id, input.ownerId, input.type, JSON.stringify(input.data), input.isSaved ? 1 : 0, input.memoryAt,
      input.seenAt ?? null, input.showAt ?? null, input.hideAt ?? null, now,
    ),
    ...ids.map((assetId) =>
      tracked('INSERT INTO memory_assets (memory_id, asset_id, update_id) SELECT ?1, ?2, :cursor WHERE EXISTS (SELECT 1 FROM memories WHERE id = ?1)', id, assetId),
    ),
  ]);
  const exists = await db.prepare('SELECT 1 AS x FROM memories WHERE id = ?1').bind(id).first();
  return exists ? id : null;
}

/** Bumps updated_at (and so the sync cursor) of a memory. */
export function touchMemory(id: string, now = new Date().toISOString()) {
  return tracked('UPDATE memories SET updated_at = ?2, update_id = :cursor WHERE id = ?1', id, now);
}

export async function deleteMemory(db: D1Database, m: Pick<MemoryRow, 'id' | 'owner_id'>): Promise<void> {
  await commit(db, [
    tracked(
      'INSERT INTO memory_audit (id, memory_id, user_id, deleted_at) SELECT :cursor, ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM memories WHERE id = ?1)',
      m.id, m.owner_id, new Date().toISOString(),
    ),
    db.prepare('DELETE FROM memories WHERE id = ?1').bind(m.id),
  ]);
}

export async function addMemoryAssets(db: D1Database, memoryId: string, assetIds: string[]): Promise<void> {
  if (assetIds.length === 0) return;
  await commit(db, [
    ...assetIds.map((a) => tracked('INSERT OR IGNORE INTO memory_assets (memory_id, asset_id, update_id) VALUES (?1, ?2, :cursor)', memoryId, a)),
    touchMemory(memoryId),
  ]);
}

export async function removeMemoryAssets(db: D1Database, m: Pick<MemoryRow, 'id' | 'owner_id'>, assetIds: string[]): Promise<void> {
  if (assetIds.length === 0) return;
  const now = new Date().toISOString();
  await commit(db, [
    ...assetIds.flatMap((a) => [
      tracked(
        'INSERT INTO memory_asset_audit (id, memory_id, asset_id, owner_id, deleted_at) SELECT :cursor, ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM memory_assets WHERE memory_id = ?1 AND asset_id = ?2)',
        m.id, a, m.owner_id, now,
      ),
      db.prepare('DELETE FROM memory_assets WHERE memory_id = ?1 AND asset_id = ?2').bind(m.id, a),
    ]),
    touchMemory(m.id, now),
  ]);
}

export async function existingMemoryAssetIds(db: D1Database, memoryId: string, ids: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (const part of chunks([...new Set(ids)])) {
    const { results } = await db.prepare(`SELECT asset_id FROM memory_assets WHERE memory_id = ?1 AND asset_id IN (${marks(part.length, 2)})`).bind(memoryId, ...part).all<{ asset_id: string }>();
    for (const r of results) found.add(r.asset_id);
  }
  return found;
}

/**
 * Audit rows for memory_assets that cascade away when assets are purged. Call before the asset DELETE statements in the
 * same commit; each statement is guarded so a repeated run writes nothing.
 */
export async function memoryAssetPurgeAudit(db: D1Database, assetIds: string[], guardFor?: (assetId: string) => RowGuard) {
  const now = new Date().toISOString();
  const items = [];
  for (const part of chunks(assetIds)) {
    const { results } = await db
      .prepare(`SELECT ma.memory_id, ma.asset_id, m.owner_id FROM memory_assets ma JOIN memories m ON m.id = ma.memory_id WHERE ma.asset_id IN (${marks(part.length)})`)
      .bind(...part)
      .all<{ memory_id: string; asset_id: string; owner_id: string }>();
    for (const r of results) {
      // The guard (when given) holds only while the asset is still about to be deleted, so a racing restore writes no audit.
      const g = guardFor?.(r.asset_id);
      items.push(
        tracked(
          `INSERT INTO memory_asset_audit (id, memory_id, asset_id, owner_id, deleted_at) SELECT :cursor, ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM memory_assets WHERE memory_id = ?1 AND asset_id = ?2)${g ? ` AND ${g.sql('?5')}` : ''}`,
          r.memory_id, r.asset_id, r.owner_id, now, ...(g ? [g.value] : []),
        ),
      );
    }
  }
  return items;
}
