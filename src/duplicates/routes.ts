// Phase 4 Task C: GET /duplicates, DELETE /duplicates, DELETE /duplicates/{id}, POST /duplicates/resolve
// (Immich duplicate.controller.ts and duplicate.service.ts).
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { allowedAlbumIds, albumAssetIds, bumpAlbum, insertAlbumAsset } from '../albums/repo';
import { isUuid, parseIds, readJson } from '../assets/access';
import { mapAssetResponse } from '../assets/map';
import { applyPatch, loadExifRows, type AssetPatch, type Visibility } from '../assets/update';
import { requireAuth } from '../auth/session';
import { getSystemConfig } from '../config/store';
import { BATCH, purgeAssets } from '../cron/purge';
import { commit, tracked, type Tracked } from '../db/changes';
import type { AssetRow, ExifRow } from '../db/rows';
import type { Dto } from '../gen/dto';
import { ImmichError } from '../http/errors';
import { mapTag, type TagRow } from '../tags/routes';

export const duplicateRoutes = new Hono<AppEnv>();

const IN_CHUNK = 90;
const json = (v: unknown) => JSON.stringify(v);
const DEFAULT_VISIBILITY = "visibility IN ('timeline', 'archive')";

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function commitChunks(db: D1Database, items: Array<Tracked | D1PreparedStatement>): Promise<void> {
  for (const part of chunked(items, 100)) await commit(db, part);
}

const setGroup = (id: string, ownerId: string, now: string) =>
  tracked('UPDATE assets SET duplicate_id = NULL, updated_at = ?2, update_id = :cursor WHERE id = ?1 AND owner_id = ?3', id, now, ownerId);

// ---- suggestions (Immich utils/duplicate.ts) ----

const exifCount = (a: Dto<'AssetResponseDto'>) => Object.values(a.exifInfo ?? {}).filter(Boolean).length;

export function suggestKeep(assets: Array<Dto<'AssetResponseDto'>>): string[] {
  if (assets.length === 0) return [];
  const size = (a: Dto<'AssetResponseDto'>) => a.exifInfo?.fileSizeInByte ?? 0;
  const largest = Math.max(...assets.map(size));
  const best = assets.filter((a) => size(a) === largest).sort((a, b) => exifCount(a) - exifCount(b));
  return [best[best.length - 1].id];
}

// ---- reads ----

/** Immich cleanupSingletonGroups: assets alone in their group lose the group id. */
async function cleanupSingletons(db: D1Database, ownerId: string): Promise<void> {
  const { results } = await db
    .prepare(
      `SELECT a.id FROM assets a WHERE a.owner_id = ?1 AND a.duplicate_id IS NOT NULL AND a.deleted_at IS NULL AND a.stack_id IS NULL
         AND (SELECT count(*) FROM assets b WHERE b.owner_id = a.owner_id AND b.duplicate_id = a.duplicate_id AND b.deleted_at IS NULL AND b.stack_id IS NULL) = 1`,
    )
    .bind(ownerId)
    .all<{ id: string }>();
  const now = new Date().toISOString();
  await commitChunks(db, results.map((r) => setGroup(r.id, ownerId, now)));
}

async function tagsFor(db: D1Database, ids: string[]): Promise<Map<string, TagRow[]>> {
  const map = new Map<string, TagRow[]>();
  for (const part of chunked(ids, 500)) {
    const { results } = await db
      .prepare('SELECT ta.asset_id, t.* FROM tag_asset ta JOIN tags t ON t.id = ta.tag_id WHERE ta.asset_id IN (SELECT value FROM json_each(?1)) ORDER BY t.value')
      .bind(json(part))
      .all<TagRow & { asset_id: string }>();
    for (const { asset_id, ...tag } of results) map.set(asset_id, [...(map.get(asset_id) ?? []), tag]);
  }
  return map;
}

duplicateRoutes.get('/duplicates', requireAuth, async (c) => {
  const db = c.env.DB;
  const ownerId = c.get('auth').user.id;
  await cleanupSingletons(db, ownerId);
  const { results: rows } = await db
    .prepare(
      `SELECT * FROM assets WHERE owner_id = ?1 AND duplicate_id IS NOT NULL AND deleted_at IS NULL AND stack_id IS NULL AND ${DEFAULT_VISIBILITY}
       ORDER BY local_date_time ASC, id ASC`,
    )
    .bind(ownerId)
    .all<AssetRow>();
  const groups = new Map<string, AssetRow[]>();
  for (const r of rows) groups.set(r.duplicate_id!, [...(groups.get(r.duplicate_id!) ?? []), r]);
  const kept = [...groups.entries()].filter(([, list]) => list.length > 1);
  const ids = kept.flatMap(([, list]) => list.map((a) => a.id));
  const exif = await loadExifRows(db, ids);
  const tags = await tagsFor(db, ids);
  const out: Array<Dto<'DuplicateResponseDto'>> = kept.map(([duplicateId, list]) => {
    const assets = list.map((a) => ({
      ...mapAssetResponse(a, exif.get(a.id) ?? null),
      duplicateId,
      tags: (tags.get(a.id) ?? []).map(mapTag),
    }));
    return { duplicateId, assets, suggestedKeepAssetIds: suggestKeep(assets) };
  });
  return c.json(out);
});

// ---- dismiss ----

/** Immich checkOwnerAccess(DuplicateDelete): the caller owns a non-trashed asset in each group; else 400. */
async function requireGroups(db: D1Database, ownerId: string, ids: string[]): Promise<void> {
  const unique = [...new Set(ids)];
  const owned = new Set<string>();
  for (const part of chunked(unique, IN_CHUNK)) {
    const { results } = await db
      .prepare('SELECT DISTINCT duplicate_id FROM assets WHERE owner_id = ?1 AND deleted_at IS NULL AND duplicate_id IN (SELECT value FROM json_each(?2))')
      .bind(ownerId, json(part))
      .all<{ duplicate_id: string }>();
    for (const r of results) owned.add(r.duplicate_id);
  }
  if (owned.size !== unique.length) throw new ImmichError(400, 'Not found or no duplicate.delete access');
}

async function dismiss(db: D1Database, ownerId: string, ids: string[]): Promise<void> {
  const now = new Date().toISOString();
  const members: string[] = [];
  for (const part of chunked([...new Set(ids)], IN_CHUNK)) {
    const { results } = await db
      .prepare('SELECT id FROM assets WHERE owner_id = ?1 AND duplicate_id IN (SELECT value FROM json_each(?2))')
      .bind(ownerId, json(part))
      .all<{ id: string }>();
    members.push(...results.map((r) => r.id));
  }
  await commitChunks(db, members.map((id) => setGroup(id, ownerId, now)));
}

duplicateRoutes.delete('/duplicates', requireAuth, async (c) => {
  const body = await readJson(c);
  const ids = parseIds(body.ids);
  const ownerId = c.get('auth').user.id;
  await requireGroups(c.env.DB, ownerId, ids);
  await dismiss(c.env.DB, ownerId, ids);
  return c.body(null, 204);
});

duplicateRoutes.delete('/duplicates/:id', requireAuth, async (c) => {
  const id = c.req.param('id');
  if (!isUuid(id)) throw new ImmichError(400, 'id must be a UUID');
  const ownerId = c.get('auth').user.id;
  await requireGroups(c.env.DB, ownerId, [id]);
  await dismiss(c.env.DB, ownerId, [id]);
  return c.body(null, 204);
});

// ---- resolve ----

type Result = Dto<'BulkIdResponseDto'>;

const fail = (id: string, error: Result['error'], errorMessage?: string): Result => ({ id, success: false, error, ...(errorMessage ? { errorMessage } : {}) });

function uniqueLines(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const value of values) {
    if (!value) continue;
    for (const line of value.split(/\r?\n/)) {
      const t = line.trim();
      if (t && !seen.has(t)) {
        seen.add(t);
        lines.push(t);
      }
    }
  }
  return lines;
}

/** Immich getSyncMergeResult: what the kept asset absorbs from the group. */
function mergePatch(assets: AssetRow[], exif: Map<string, ExifRow>): AssetPatch {
  const patch: AssetPatch = { isFavorite: assets.some((a) => a.is_favorite === 1) };
  const order: Visibility[] = ['locked', 'archive', 'timeline'];
  const visibility = order.find((v) => assets.some((a) => a.visibility === v)) ?? (assets.some((a) => a.visibility === 'hidden') ? 'hidden' : undefined);
  if (visibility) patch.visibility = visibility;
  const rating = Math.max(0, ...assets.map((a) => exif.get(a.id)?.rating ?? 0));
  if (rating > 0) patch.rating = rating;
  const lines = uniqueLines(assets.map((a) => exif.get(a.id)?.description));
  if (lines.length > 0) patch.description = lines.join('\n');
  const unique = (key: 'latitude' | 'longitude') => {
    const values = assets.map((a) => exif.get(a.id)?.[key]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const set = new Set(values);
    return set.size === 1 ? values[0] : null;
  };
  const latitude = unique('latitude');
  const longitude = unique('longitude');
  if (latitude !== null && longitude !== null) {
    patch.latitude = latitude;
    patch.longitude = longitude;
  }
  return patch;
}

async function mergeIntoKeeper(env: Env, ownerId: string, group: AssetRow[], keeper: AssetRow, now: string): Promise<void> {
  const ids = group.map((a) => a.id);
  const exif = await loadExifRows(env.DB, ids);

  // Albums holding any group asset gain the keeper where the caller may add assets.
  const { results: albumRows } = await env.DB.prepare('SELECT DISTINCT album_id FROM album_assets WHERE asset_id IN (SELECT value FROM json_each(?1))').bind(json(ids)).all<{ album_id: string }>();
  const allowed = await allowedAlbumIds(env.DB, ownerId, albumRows.map((r) => r.album_id), 'assetCreate');
  for (const albumId of allowed) {
    if ((await albumAssetIds(env.DB, albumId, [keeper.id])).size > 0) continue;
    await commit(env.DB, [insertAlbumAsset(albumId, keeper.id, now), bumpAlbum(albumId, now)]);
  }

  // The keeper takes the union of the group's tags (tags are per user; tag_asset is not a synced table).
  await env.DB
    .prepare(
      `INSERT OR IGNORE INTO tag_asset (tag_id, asset_id)
       SELECT DISTINCT ta.tag_id, ?2 FROM tag_asset ta JOIN tags t ON t.id = ta.tag_id
       WHERE t.user_id = ?3 AND ta.asset_id IN (SELECT value FROM json_each(?1))`,
    )
    .bind(json(ids), keeper.id, ownerId)
    .run();

  const patch = mergePatch(group, exif);
  await applyPatch(env, new Map([[keeper.id, keeper]]), patch);
}

async function resolveGroup(env: Env, ownerId: string, group: { duplicateId: string; keepAssetIds: string[]; trashAssetIds: string[] }): Promise<Result> {
  const { duplicateId } = group;
  const { results: members } = await env.DB
    .prepare(`SELECT * FROM assets WHERE owner_id = ?1 AND duplicate_id = ?2 AND deleted_at IS NULL AND stack_id IS NULL AND ${DEFAULT_VISIBILITY} ORDER BY local_date_time ASC`)
    .bind(ownerId, duplicateId)
    .all<AssetRow>();
  if (members.length === 0) return fail(duplicateId, 'not_found');
  const inGroup = new Set(members.map((a) => a.id));
  const keep = group.keepAssetIds.filter((id) => inGroup.has(id));
  const trash = group.trashAssetIds.filter((id) => inGroup.has(id));
  for (const id of inGroup) {
    if (keep.includes(id) && trash.includes(id)) return fail(duplicateId, 'validation', 'An asset cannot be in both keepAssetIds and trashAssetIds');
    if (!keep.includes(id) && !trash.includes(id)) return fail(duplicateId, 'validation', 'Every asset must be in either keepAssetIds or trashAssetIds');
  }

  const now = new Date().toISOString();
  if (keep.length === 1 && trash.length > 0) {
    await mergeIntoKeeper(env, ownerId, members, members.find((a) => a.id === keep[0])!, now);
  }
  await commitChunks(env.DB, keep.map((id) => setGroup(id, ownerId, now)));

  if (trash.length > 0) {
    await commitChunks(
      env.DB,
      trash.map((id) =>
        tracked('UPDATE assets SET deleted_at = ?2, duplicate_id = NULL, updated_at = ?2, update_id = :cursor WHERE id = ?1 AND owner_id = ?3 AND deleted_at IS NULL', id, now, ownerId),
      ),
    );
    if (!(await getSystemConfig(env.DB)).trash.enabled) {
      const rows = members.filter((a) => trash.includes(a.id)).map((a) => ({ ...a, deleted_at: now }));
      for (const part of chunked(rows, BATCH)) await purgeAssets(env, part, new Date());
    }
  }
  return { id: duplicateId, success: true };
}

duplicateRoutes.post('/duplicates/resolve', requireAuth, async (c) => {
  const body = await readJson(c);
  if (!Array.isArray(body.groups) || body.groups.length === 0) throw new ImmichError(400, 'groups must be a non-empty array');
  const groups = body.groups.map((g: any) => {
    if (!g || typeof g !== 'object' || !isUuid(g.duplicateId)) throw new ImmichError(400, 'duplicateId must be a UUID');
    return { duplicateId: g.duplicateId as string, keepAssetIds: parseIds(g.keepAssetIds, 'keepAssetIds'), trashAssetIds: parseIds(g.trashAssetIds, 'trashAssetIds') };
  });
  const ownerId = c.get('auth').user.id;
  await requireGroups(c.env.DB, ownerId, groups.map((g) => g.duplicateId));
  const results: Result[] = [];
  for (const g of groups) {
    try {
      results.push(await resolveGroup(c.env, ownerId, g));
    } catch (err) {
      console.error('duplicate resolve failed', g.duplicateId, err);
      results.push(fail(g.duplicateId, 'unknown'));
    }
  }
  return c.json(results);
});
