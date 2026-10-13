import { tracked, type Tracked } from '../db/changes';
import type { AssetRow, ExifRow } from '../db/rows';
import type { Dto } from '../gen/dto';
import { mapAssetResponse } from '../assets/map';
import { mapTag, type TagRow } from '../tags/routes';
import { chunks, json } from '../tags/util';

export interface StackRow {
  id: string;
  owner_id: string;
  primary_asset_id: string;
  created_at: string;
  updated_at: string;
  update_id: string;
}

/** Immich's withDefaultVisibility: stack listings show timeline and archive assets that are not trashed. */
const VISIBLE = "a.deleted_at IS NULL AND a.visibility IN ('timeline', 'archive')";

export function clearAssetStack(assetId: string, now: string): Tracked {
  return tracked('UPDATE assets SET stack_id = NULL, updated_at = ?2, update_id = :cursor WHERE id = ?1', assetId, now);
}

export function setAssetStack(assetId: string, stackId: string, now: string): Tracked {
  return tracked('UPDATE assets SET stack_id = ?2, updated_at = ?3, update_id = :cursor WHERE id = ?1', assetId, stackId, now);
}

/** Audit row plus delete for one stack. The audit insert is guarded so that a retry writes nothing. */
export function deleteStackItems(db: D1Database, stackId: string, now: string): Array<Tracked | D1PreparedStatement> {
  return [
    tracked('INSERT INTO stack_audit (id, stack_id, owner_id, deleted_at) SELECT :cursor, id, owner_id, ?2 FROM stacks WHERE id = ?1', stackId, now),
    db.prepare('DELETE FROM stacks WHERE id = ?1').bind(stackId),
  ];
}

export async function memberIds(db: D1Database, stackIds: string[]): Promise<Array<{ id: string; stack_id: string; deleted_at: string | null }>> {
  if (stackIds.length === 0) return [];
  const { results } = await db
    .prepare('SELECT id, stack_id, deleted_at FROM assets WHERE stack_id IN (SELECT value FROM json_each(?1)) ORDER BY file_created_at')
    .bind(json(stackIds))
    .all<{ id: string; stack_id: string; deleted_at: string | null }>();
  return results;
}

/**
 * Items that keep stacks consistent when assets are hard deleted (purge). A stack whose primary is deleted gets
 * another member as primary when at least two members remain, and is dissolved otherwise (Immich's handleAssetDeletion).
 */
export async function stackItemsForDeletedAssets(
  db: D1Database,
  assetIds: string[],
  now: string,
  trashedIds: Set<string> = new Set(),
  /** An extra SQL condition (no binds) every statement also requires, e.g. that the owner is still deleted (user purge). */
  extraGuard = '',
  /** SQL (no binds) that holds while the purge will still delete this primary; defaults to "exists, and still trashed if it was". */
  primaryGuard: (assetId: string) => string = (id) => `EXISTS (SELECT 1 FROM assets WHERE id = '${id}'${trashedIds.has(id) ? ' AND deleted_at IS NOT NULL' : ''})`,
): Promise<Array<Tracked | D1PreparedStatement>> {
  const extra = extraGuard ? ` AND ${extraGuard}` : '';
  if (assetIds.length === 0) return [];
  const gone = new Set(assetIds);
  const { results: stacks } = await db
    .prepare('SELECT * FROM stacks WHERE primary_asset_id IN (SELECT value FROM json_each(?1))')
    .bind(json(assetIds))
    .all<StackRow>();
  const items: Array<Tracked | D1PreparedStatement> = [];
  const members = await memberIds(db, stacks.map((s) => s.id));
  for (const stack of stacks) {
    const p = stack.primary_asset_id;
    // Each statement acts only while the primary is still a row that the purge is about to delete (trashed ones must still be trashed),
    // so a restore that lands between the purge's read and its commit leaves the stack alone.
    const guard = `stack_id_guard AND ${primaryGuard(p)}${extra}`;
    const stillPrimary = `EXISTS (SELECT 1 FROM stacks WHERE id = ?1 AND primary_asset_id = '${p}')`;
    const when = guard.replace('stack_id_guard', stillPrimary);
    const remaining = members.filter((m) => m.stack_id === stack.id && !gone.has(m.id)).map((m) => m.id);
    if (remaining.length >= 2) {
      items.push(tracked(`UPDATE stacks SET primary_asset_id = ?2, updated_at = ?3, update_id = :cursor WHERE id = ?1 AND ${when}`, stack.id, remaining[0], now));
    } else {
      items.push(
        tracked(`INSERT INTO stack_audit (id, stack_id, owner_id, deleted_at) SELECT :cursor, id, owner_id, ?2 FROM stacks WHERE id = ?1 AND ${when}`, stack.id, now),
        db.prepare(`DELETE FROM stacks WHERE id = ?1 AND ${when}`).bind(stack.id),
      );
      // The guard runs before the stack delete above removes the stack, but each clear is its own statement, so test the asset only.
      for (const id of remaining) {
        items.push(tracked(`UPDATE assets SET stack_id = NULL, updated_at = ?3, update_id = :cursor WHERE id = ?1 AND stack_id = ?2 AND ${primaryGuard(p)}${extra}`, id, stack.id, now));
      }
    }
  }
  return items;
}

export interface StackWithAssets {
  stack: StackRow;
  assets: AssetRow[];
}

async function exifFor(db: D1Database, assetIds: string[]): Promise<Map<string, ExifRow>> {
  const map = new Map<string, ExifRow>();
  for (const part of chunks(assetIds, 500)) {
    const { results } = await db.prepare('SELECT * FROM asset_exif WHERE asset_id IN (SELECT value FROM json_each(?1))').bind(json(part)).all<ExifRow>();
    for (const e of results) map.set(e.asset_id, e);
  }
  return map;
}

async function tagsFor(db: D1Database, assetIds: string[]): Promise<Map<string, TagRow[]>> {
  const map = new Map<string, TagRow[]>();
  for (const part of chunks(assetIds, 500)) {
    const { results } = await db
      .prepare(
        `SELECT ta.asset_id, t.* FROM tag_asset ta JOIN tags t ON t.id = ta.tag_id
         WHERE ta.asset_id IN (SELECT value FROM json_each(?1)) ORDER BY t.value`,
      )
      .bind(json(part))
      .all<TagRow & { asset_id: string }>();
    for (const { asset_id, ...tag } of results) map.set(asset_id, [...(map.get(asset_id) ?? []), tag]);
  }
  return map;
}

export async function loadStacks(db: D1Database, stacks: StackRow[]): Promise<StackWithAssets[]> {
  if (stacks.length === 0) return [];
  const { results } = await db
    .prepare(`SELECT a.* FROM assets a WHERE a.stack_id IN (SELECT value FROM json_each(?1)) AND ${VISIBLE} ORDER BY a.file_created_at ASC`)
    .bind(json(stacks.map((s) => s.id)))
    .all<AssetRow>();
  return stacks.map((stack) => ({ stack, assets: results.filter((a) => a.stack_id === stack.id) }));
}

export async function mapStacks(db: D1Database, loaded: StackWithAssets[], withTags: boolean): Promise<Dto<'StackResponseDto'>[]> {
  const ids = loaded.flatMap((l) => l.assets.map((a) => a.id));
  const exif = await exifFor(db, ids);
  const tags = withTags ? await tagsFor(db, ids) : new Map<string, TagRow[]>();
  return loaded.map(({ stack, assets }) => {
    const primary = assets.filter((a) => a.id === stack.primary_asset_id);
    const others = assets.filter((a) => a.id !== stack.primary_asset_id);
    return {
      id: stack.id,
      primaryAssetId: stack.primary_asset_id,
      assets: [...primary, ...others].map((a) => ({
        ...mapAssetResponse(a, exif.get(a.id) ?? null),
        ...(withTags ? { tags: (tags.get(a.id) ?? []).map(mapTag) } : {}),
      })),
    };
  });
}

/** `stack` and `tags` fields of a single-asset response, as Immich's getById returns them. */
export async function assetExtras(db: D1Database, asset: AssetRow): Promise<Pick<Dto<'AssetResponseDto'>, 'stack' | 'tags'>> {
  const tags = await tagsFor(db, [asset.id]);
  let stack: Dto<'AssetStackResponseDto'> | null = null;
  if (asset.stack_id) {
    const row = await db
      .prepare(
        `SELECT s.id, s.primary_asset_id,
                (SELECT count(*) FROM assets m WHERE m.stack_id = s.id AND m.id <> s.primary_asset_id AND m.deleted_at IS NULL AND m.visibility = 'timeline') AS others
         FROM stacks s WHERE s.id = ?1`,
      )
      .bind(asset.stack_id)
      .first<{ id: string; primary_asset_id: string; others: number }>();
    if (row) stack = { id: row.id, primaryAssetId: row.primary_asset_id, assetCount: row.others + 1 };
  }
  return { stack, tags: (tags.get(asset.id) ?? []).map(mapTag) };
}
