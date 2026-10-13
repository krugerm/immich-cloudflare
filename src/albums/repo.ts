import type { Context } from 'hono';
import type { AppEnv } from '../app';
import { commit, tracked, type Tracked } from '../db/changes';
import type { UserRow } from '../db/rows';
import type { Dto } from '../gen/dto';
import { ImmichError } from '../http/errors';
import { getSharedLink } from '../shared-links/auth';
import { mapUserShort } from '../users/extra';

export type AlbumRole = 'owner' | 'editor' | 'viewer';

export interface AlbumRow {
  id: string;
  name: string;
  description: string | null;
  thumbnail_asset_id: string | null;
  asset_order: 'asc' | 'desc';
  is_activity_enabled: number;
  created_at: string;
  updated_at: string;
  update_id: string;
}

/** Rows written per D1 batch for bulk album changes (two statements per tracked row). */
export const WRITE_CHUNK = 400;

// ---- access (Immich utils/access.ts, album permissions) ----

export type AlbumPermission = 'read' | 'download' | 'update' | 'share' | 'delete' | 'assetCreate' | 'assetDelete';

const PERMISSION_NAME: Record<AlbumPermission, string> = {
  read: 'album.read',
  download: 'album.download',
  update: 'album.update',
  share: 'album.share',
  delete: 'album.delete',
  assetCreate: 'albumAsset.create',
  assetDelete: 'albumAsset.delete',
};

/** Owner: everything. Editor: everything but delete. Viewer: read and download. */
export function roleAllows(role: AlbumRole | null, permission: AlbumPermission): boolean {
  if (!role) return false;
  if (role === 'owner') return true;
  if (permission === 'delete') return false;
  return role === 'editor' || permission === 'read' || permission === 'download';
}

export async function albumRole(db: D1Database, albumId: string, userId: string): Promise<AlbumRole | null> {
  const row = await db
    .prepare('SELECT au.role FROM album_users au JOIN users u ON u.id = au.user_id AND u.deleted_at IS NULL WHERE au.album_id = ?1 AND au.user_id = ?2')
    .bind(albumId, userId)
    .first<{ role: AlbumRole }>();
  return row?.role ?? null;
}

export function accessError(permission: AlbumPermission): ImmichError {
  return new ImmichError(400, `Not found or no ${PERMISSION_NAME[permission]} access`);
}

/** Immich requireAccess for one album; shared-link callers reach only their link's album. */
export async function requireAlbumAccess(c: Context<AppEnv>, albumId: string, permission: AlbumPermission): Promise<void> {
  const shared = getSharedLink(c);
  if (shared) {
    const { link } = shared;
    const ok =
      link.album_id === albumId &&
      (permission === 'read' || (permission === 'download' && link.allow_download === 1) || (permission === 'assetCreate' && link.allow_upload === 1));
    if (!ok) throw accessError(permission);
    return;
  }
  if (!roleAllows(await albumRole(c.env.DB, albumId, c.get('auth').user.id), permission)) throw accessError(permission);
}

/** Album ids among `albumIds` where the user holds `permission`. */
export async function allowedAlbumIds(db: D1Database, userId: string, albumIds: string[], permission: AlbumPermission): Promise<Set<string>> {
  if (albumIds.length === 0) return new Set();
  const { results } = await db
    .prepare(
      `SELECT au.album_id, au.role FROM album_users au JOIN users u ON u.id = au.user_id AND u.deleted_at IS NULL
       WHERE au.user_id = ?1 AND au.album_id IN (SELECT value FROM json_each(?2))`,
    )
    .bind(userId, JSON.stringify(albumIds))
    .all<{ album_id: string; role: AlbumRole }>();
  return new Set(results.filter((r) => roleAllows(r.role, permission)).map((r) => r.album_id));
}

// ---- reads ----

export function getAlbum(db: D1Database, id: string): Promise<AlbumRow | null> {
  return db.prepare('SELECT * FROM albums WHERE id = ?1').bind(id).first<AlbumRow>();
}

export async function findAlbumOrFail(db: D1Database, id: string): Promise<AlbumRow> {
  const album = await getAlbum(db, id);
  if (!album) throw new ImmichError(400, 'Album not found');
  return album;
}

export async function albumMembers(db: D1Database, albumId: string): Promise<Array<{ user_id: string; role: AlbumRole }>> {
  const { results } = await db.prepare('SELECT user_id, role FROM album_users WHERE album_id = ?1').bind(albumId).all<{ user_id: string; role: AlbumRole }>();
  return results;
}

/** Asset ids among `assetIds` already in the album. */
export async function albumAssetIds(db: D1Database, albumId: string, assetIds: string[]): Promise<Set<string>> {
  if (assetIds.length === 0) return new Set();
  const { results } = await db
    .prepare('SELECT asset_id FROM album_assets WHERE album_id = ?1 AND asset_id IN (SELECT value FROM json_each(?2))')
    .bind(albumId, JSON.stringify(assetIds))
    .all<{ asset_id: string }>();
  return new Set(results.map((r) => r.asset_id));
}

// Non-trashed album assets with Immich's default visibility (timeline + archive).
const LIVE_ALBUM_ASSET = "a.deleted_at IS NULL AND a.visibility IN ('timeline', 'archive')";

const THUMB_CANDIDATE = `(SELECT aa.asset_id FROM album_assets aa JOIN assets a ON a.id = aa.asset_id AND a.deleted_at IS NULL AND a.visibility != 'locked'
  WHERE aa.album_id = albums.id ORDER BY a.file_created_at DESC LIMIT 1)`;

/**
 * Immich AlbumRepository.updateThumbnails, scoped to the given albums: set a thumbnail where none is set and the album has
 * assets, and replace one that is no longer a non-trashed album asset. One tracked update per album that needs it.
 * Returns true if anything changed.
 */
export async function repairThumbnails(db: D1Database, albumIds: string[]): Promise<boolean> {
  if (albumIds.length === 0) return false;
  const { results } = await db
    .prepare(
      `SELECT albums.id FROM albums WHERE albums.id IN (SELECT value FROM json_each(?1)) AND (
         (thumbnail_asset_id IS NULL AND ${THUMB_CANDIDATE} IS NOT NULL)
         OR (thumbnail_asset_id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM album_assets aa JOIN assets a ON a.id = aa.asset_id AND a.deleted_at IS NULL AND a.visibility != 'locked'
           WHERE aa.album_id = albums.id AND aa.asset_id = albums.thumbnail_asset_id)))`,
    )
    .bind(JSON.stringify(albumIds))
    .all<{ id: string }>();
  if (results.length === 0) return false;
  const now = new Date().toISOString();
  await commit(
    db,
    results.map((r) => tracked(`UPDATE albums SET thumbnail_asset_id = ${THUMB_CANDIDATE}, updated_at = ?2, update_id = :cursor WHERE id = ?1`, r.id, now)),
  );
  return true;
}

const ROLE_RANK = { owner: 0, editor: 1, viewer: 2 } as const;

/** AlbumResponseDto for each album (Immich mapAlbum + getMetadataForIds), three queries for any number of albums. */
export async function mapAlbums(
  db: D1Database,
  albums: AlbumRow[],
  viewerId: string,
  opts: { contributors?: boolean; forceShared?: boolean } = {},
): Promise<Dto<'AlbumResponseDto'>[]> {
  if (albums.length === 0) return [];
  const ids = JSON.stringify(albums.map((a) => a.id));
  const [members, meta, links] = await db.batch([
    db.prepare(`SELECT au.album_id AS au_album_id, au.role AS au_role, u.* FROM album_users au JOIN users u ON u.id = au.user_id WHERE au.album_id IN (SELECT value FROM json_each(?1))`).bind(ids),
    db.prepare(
      `SELECT aa.album_id, count(*) AS n, min(date(a.local_date_time)) AS start, max(date(a.local_date_time)) AS end, max(a.updated_at) AS last
       FROM album_assets aa JOIN assets a ON a.id = aa.asset_id WHERE aa.album_id IN (SELECT value FROM json_each(?1)) AND ${LIVE_ALBUM_ASSET}
       GROUP BY aa.album_id`,
    ).bind(ids),
    db.prepare('SELECT DISTINCT album_id FROM shared_links WHERE album_id IN (SELECT value FROM json_each(?1))').bind(ids),
  ]);
  const usersByAlbum = new Map<string, Array<{ role: AlbumRole; user: UserRow }>>();
  for (const row of members.results as Array<Record<string, any>>) {
    const { au_album_id, au_role, ...user } = row;
    const list = usersByAlbum.get(au_album_id) ?? [];
    list.push({ role: au_role, user: user as UserRow });
    usersByAlbum.set(au_album_id, list);
  }
  const metaByAlbum = new Map((meta.results as Array<{ album_id: string; n: number; start: string; end: string; last: string }>).map((m) => [m.album_id, m]));
  const linked = new Set((links.results as Array<{ album_id: string }>).map((l) => l.album_id));

  const contributors = new Map<string, Array<{ userId: string; assetCount: number }>>();
  if (opts.contributors) {
    const sharedIds = albums.filter((a) => (usersByAlbum.get(a.id)?.length ?? 0) > 1 || linked.has(a.id)).map((a) => a.id);
    if (sharedIds.length) {
      const { results } = await db
        .prepare(
          `SELECT aa.album_id, a.owner_id AS userId, count(*) AS assetCount FROM album_assets aa JOIN assets a ON a.id = aa.asset_id
           WHERE aa.album_id IN (SELECT value FROM json_each(?1)) AND a.deleted_at IS NULL AND a.visibility != 'locked'
           GROUP BY aa.album_id, a.owner_id ORDER BY assetCount DESC`,
        )
        .bind(JSON.stringify(sharedIds))
        .all<{ album_id: string; userId: string; assetCount: number }>();
      for (const id of sharedIds) contributors.set(id, []);
      for (const r of results) contributors.get(r.album_id)!.push({ userId: r.userId, assetCount: r.assetCount });
    }
  }

  const day = (d: string | undefined) => (d ? `${d}T00:00:00.000Z` : undefined);
  return albums.map((a) => {
    const users = (usersByAlbum.get(a.id) ?? []).sort(
      (x, y) => ROLE_RANK[x.role] - ROLE_RANK[y.role] || Number(y.user.id === viewerId) - Number(x.user.id === viewerId) || x.user.name.localeCompare(y.user.name),
    );
    const m = metaByAlbum.get(a.id);
    const hasSharedLink = opts.forceShared || linked.has(a.id);
    return {
      id: a.id,
      albumName: a.name,
      description: a.description ?? '',
      albumThumbnailAssetId: a.thumbnail_asset_id,
      createdAt: a.created_at,
      updatedAt: a.updated_at,
      albumUsers: users.map((u) => ({ role: u.role, user: mapUserShort(u.user) })),
      shared: users.length > 1 || hasSharedLink,
      hasSharedLink,
      startDate: day(m?.start),
      endDate: day(m?.end),
      assetCount: m?.n ?? 0,
      lastModifiedAssetTimestamp: m?.last,
      isActivityEnabled: a.is_activity_enabled === 1,
      order: a.asset_order,
      contributorCounts: contributors.get(a.id),
    };
  });
}

// ---- writes (every synced row through tracked) ----

export function bumpAlbum(albumId: string, now: string, extraSet = '', ...binds: unknown[]): Tracked {
  return tracked(`UPDATE albums SET updated_at = ?2${extraSet}, update_id = :cursor WHERE id = ?1`, albumId, now, ...binds);
}

export function insertAlbumUser(albumId: string, userId: string, role: AlbumRole, now: string): Tracked {
  return tracked(
    'INSERT INTO album_users (album_id, user_id, role, create_id, created_at, updated_at, update_id) VALUES (?1, ?2, ?3, :cursor, ?4, ?4, :cursor)',
    albumId,
    userId,
    role,
    now,
  );
}

export function insertAlbumAsset(albumId: string, assetId: string, now: string): Tracked {
  return tracked('INSERT OR IGNORE INTO album_assets (album_id, asset_id, created_at, update_id) VALUES (?1, ?2, ?3, :cursor)', albumId, assetId, now);
}

/** Commits album asset inserts in chunks, then `after` (e.g. the album bump) with the last chunk. */
export async function commitChunked(db: D1Database, items: Tracked[], after: Array<Tracked | D1PreparedStatement> = []): Promise<void> {
  if (items.length === 0) {
    if (after.length) await commit(db, after);
    return;
  }
  for (let i = 0; i < items.length; i += WRITE_CHUNK) {
    const chunk: Array<Tracked | D1PreparedStatement> = items.slice(i, i + WRITE_CHUNK);
    if (i + WRITE_CHUNK >= items.length) chunk.push(...after);
    await commit(db, chunk);
  }
}

/** Immich AlbumUserRepository.delete + its audit triggers: the removed user gets AlbumDeleteV1, remaining members AlbumUserDeleteV1. */
export function removeAlbumUser(db: D1Database, albumId: string, userId: string, now: string, guard?: RowGuard): Array<Tracked | D1PreparedStatement> {
  if (guard) {
    const member = 'EXISTS (SELECT 1 FROM album_users WHERE album_id = ?1 AND user_id = ?2)';
    return [
      tracked(`INSERT INTO album_audit (id, album_id, user_id, deleted_at) SELECT :cursor, ?1, ?2, ?3 WHERE ${member} AND ${guard.sql('?4')}`, albumId, userId, now, guard.value),
      tracked(`INSERT INTO album_user_audit (id, album_id, user_id, deleted_at) SELECT :cursor, ?1, ?2, ?3 WHERE ${member} AND ${guard.sql('?4')}`, albumId, userId, now, guard.value),
      db.prepare(`DELETE FROM album_users WHERE album_id = ?1 AND user_id = ?2 AND ${guard.sql('?3')}`).bind(albumId, userId, guard.value),
    ];
  }
  return [
    tracked('INSERT INTO album_audit (id, album_id, user_id, deleted_at) VALUES (:cursor, ?1, ?2, ?3)', albumId, userId, now),
    tracked('INSERT INTO album_user_audit (id, album_id, user_id, deleted_at) VALUES (:cursor, ?1, ?2, ?3)', albumId, userId, now),
    db.prepare('DELETE FROM album_users WHERE album_id = ?1 AND user_id = ?2').bind(albumId, userId),
  ];
}

/**
 * Immich album delete: every member gets AlbumDeleteV1; child rows go by cascade without further audit.
 * With `guard`, each statement acts only while the album exists and the guard holds (the user purge).
 */
export function deleteAlbumStatements(
  db: D1Database,
  albumId: string,
  memberIds: string[],
  now: string,
  guard?: RowGuard,
): Array<Tracked | D1PreparedStatement> {
  if (guard) {
    const live = 'EXISTS (SELECT 1 FROM albums WHERE id = ?1)';
    return [
      ...memberIds.map((userId) =>
        tracked(`INSERT INTO album_audit (id, album_id, user_id, deleted_at) SELECT :cursor, ?1, ?2, ?3 WHERE ${live} AND ${guard.sql('?4')}`, albumId, userId, now, guard.value),
      ),
      db.prepare(`DELETE FROM albums WHERE id = ?1 AND ${guard.sql('?2')}`).bind(albumId, guard.value),
    ];
  }
  return [
    ...memberIds.map((userId) => tracked('INSERT INTO album_audit (id, album_id, user_id, deleted_at) VALUES (:cursor, ?1, ?2, ?3)', albumId, userId, now)),
    db.prepare('DELETE FROM albums WHERE id = ?1').bind(albumId),
  ];
}

/**
 * Immich AssetService (visibility → locked) calls AlbumRepository.removeAssetsFromAll: the asset leaves every album, with
 * an audited removal per album (members get AlbumToAssetDeleteV1) and the album thumbnail moved off it.
 * For the merge with stream B's visibility update: `await commit(db, [...assetUpdate, ...(await removeAssetFromAllAlbums(db, ownerId, assetId))])`.
 * The asset must belong to `ownerId`; otherwise nothing is returned. Run the thumbnail statements after the asset update,
 * so the new visibility is already in place when the candidate is chosen.
 */
export async function removeAssetFromAllAlbums(db: D1Database, ownerId: string, assetId: string): Promise<Array<Tracked | D1PreparedStatement>> {
  return (await removeAssetsFromAllAlbums(db, ownerId, [assetId])).get(assetId) ?? [];
}

/**
 * removeAssetFromAllAlbums for many assets of one owner with one lookup query: the statements per asset id, for
 * callers that commit each asset's update and its album removals in the same batch (C1, stream B's locked move).
 */
export async function removeAssetsFromAllAlbums(
  db: D1Database,
  ownerId: string,
  assetIds: string[],
): Promise<Map<string, Array<Tracked | D1PreparedStatement>>> {
  const out = new Map<string, Array<Tracked | D1PreparedStatement>>();
  if (assetIds.length === 0) return out;
  const { results } = await db
    .prepare(
      `SELECT aa.album_id, aa.asset_id FROM album_assets aa JOIN assets a ON a.id = aa.asset_id
       WHERE aa.asset_id IN (SELECT value FROM json_each(?1)) AND a.owner_id = ?2`,
    )
    .bind(JSON.stringify(assetIds), ownerId)
    .all<{ album_id: string; asset_id: string }>();
  const now = new Date().toISOString();
  for (const { album_id, asset_id } of results) {
    const list = out.get(asset_id) ?? [];
    list.push(
      ...removeAlbumAsset(db, album_id, asset_id, now),
      tracked(
        `UPDATE albums SET thumbnail_asset_id = ${THUMB_CANDIDATE}, updated_at = ?3, update_id = :cursor WHERE id = ?1 AND thumbnail_asset_id = ?2`,
        album_id,
        asset_id,
        now,
      ),
    );
    out.set(asset_id, list);
  }
  return out;
}

/** An SQL predicate on one bound value, given the placeholder (e.g. `?4`) to use for it. */
export interface RowGuard {
  sql: (placeholder: string) => string;
  value: unknown;
}

/**
 * The album side of hard-deleting assets (purge), for the same batch as the asset deletes and placed before them
 * (album_assets rows would otherwise go by cascade without audit): an audited removal per album (members get
 * AlbumToAssetDeleteV1), then one tracked thumbnail update per affected album whose thumbnail is a purged asset that
 * is no longer an album asset. `guardFor(assetId)` holds while the asset is still due for deletion, so a restore
 * that races the purge keeps its album rows.
 */
export async function albumItemsForPurgedAssets(
  db: D1Database,
  assetIds: string[],
  now: string,
  guardFor: (assetId: string) => RowGuard,
): Promise<Array<Tracked | D1PreparedStatement>> {
  if (assetIds.length === 0) return [];
  const ids = JSON.stringify(assetIds);
  const [members, thumbs] = await db.batch([
    db.prepare('SELECT album_id, asset_id FROM album_assets WHERE asset_id IN (SELECT value FROM json_each(?1))').bind(ids),
    db.prepare('SELECT id FROM albums WHERE thumbnail_asset_id IN (SELECT value FROM json_each(?1))').bind(ids),
  ]);
  const items: Array<Tracked | D1PreparedStatement> = [];
  const albums = new Set<string>();
  for (const { album_id, asset_id } of members.results as Array<{ album_id: string; asset_id: string }>) {
    const g = guardFor(asset_id);
    albums.add(album_id);
    items.push(
      tracked(
        `INSERT INTO album_asset_audit (id, album_id, asset_id, deleted_at) SELECT :cursor, ?1, ?2, ?3
         WHERE EXISTS (SELECT 1 FROM album_assets WHERE album_id = ?1 AND asset_id = ?2) AND ${g.sql('?4')}`,
        album_id,
        asset_id,
        now,
        g.value,
      ),
      db.prepare(`DELETE FROM album_assets WHERE album_id = ?1 AND asset_id = ?2 AND ${g.sql('?3')}`).bind(album_id, asset_id, g.value),
    );
  }
  for (const { id } of thumbs.results as Array<{ id: string }>) albums.add(id);
  for (const albumId of albums) {
    items.push(
      tracked(
        `UPDATE albums SET thumbnail_asset_id = ${THUMB_CANDIDATE}, updated_at = ?2, update_id = :cursor
         WHERE id = ?1 AND thumbnail_asset_id IN (SELECT value FROM json_each(?3))
           AND NOT EXISTS (SELECT 1 FROM album_assets WHERE album_id = ?1 AND asset_id = albums.thumbnail_asset_id)`,
        albumId,
        now,
        ids,
      ),
    );
  }
  return items;
}

export function removeAlbumAsset(db: D1Database, albumId: string, assetId: string, now: string): Array<Tracked | D1PreparedStatement> {
  return [
    tracked(
      'INSERT INTO album_asset_audit (id, album_id, asset_id, deleted_at) SELECT :cursor, ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM album_assets WHERE album_id = ?1 AND asset_id = ?2)',
      albumId,
      assetId,
      now,
    ),
    db.prepare('DELETE FROM album_assets WHERE album_id = ?1 AND asset_id = ?2').bind(albumId, assetId),
  ];
}
