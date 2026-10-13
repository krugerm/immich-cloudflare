// Album sync passes (stream C), ported from Immich sync.service.ts / sync.repository.ts.
// Loaded through ../passes, which registers ALBUM_PASSES; mapSyncAsset/mapSyncExif are only used at run time.
import type { AssetRow, ExifRow } from '../../db/rows';
import { backfill as groupBackfill, pages, syncLine as line } from '../backfill';
import { mapSyncAsset, mapSyncExif, type Pass, type StreamPass, type SyncContext } from '../passes';

function rows<T>(db: D1Database, sql: string, ...binds: unknown[]) {
  return db.prepare(sql).bind(...binds).all<T>().then((r) => r.results);
}

// Scoping: every album query joins the caller's *current* membership (album_users, user id at ?1), so a non-member or a
// removed member gets no lines for that album. Audit (delete) rows count only from the caller's own join onwards, so a
// new member does not learn about earlier removals. Another owner's locked asset is never sent, even inside a shared album.

/** Audit rows of albums the user belongs to, written after the user joined (`x` is the audit table alias). */
const MY_AUDIT = 'JOIN album_users me ON me.album_id = x.album_id AND me.user_id = ?1 AND x.id > me.create_id';

/** Albums the user currently belongs to, as a subquery with the user id at `?1`. */
const MY_ALBUMS = 'SELECT album_id FROM album_users WHERE user_id = ?1';

/** Asset `a` may be sent to user ?1. */
const VISIBLE_TO_ME = "(a.owner_id = ?1 OR a.visibility != 'locked')";

/** Immich columns.syncAlbumAsset: isFavorite is the asset's flag only for the user's own assets. */
function albumAsset(a: AssetRow, userId: string) {
  return { ...mapSyncAsset(a), isFavorite: a.owner_id === userId && a.is_favorite === 1 };
}

/** Album backfill: the groups are the user's album memberships, by membership create cursor. */
function backfill<T extends { cursor: string }>(
  type: string,
  upsertType: string,
  rows: (ctx: SyncContext, albumId: string, after: string, end: string) => D1PreparedStatement,
  map: (row: T, ctx: SyncContext) => unknown,
): StreamPass {
  return groupBackfill<T>({
    type,
    upsertType,
    groups: (ctx, afterCreate) =>
      ctx.db
        .prepare('SELECT album_id AS group_id, create_id FROM album_users WHERE user_id = ?1 AND create_id >= ?2 AND create_id <= ?3 ORDER BY create_id')
        .bind(ctx.userId, afterCreate, ctx.now),
    rows,
    map,
  });
}

// ---- AlbumsV2 ----

const albumDeletes: Pass = {
  entity: 'AlbumDeleteV1',
  async fetch(db, userId, after, now, limit) {
    const r = await rows<{ id: string; album_id: string }>(db, 'SELECT id, album_id FROM album_audit WHERE user_id = ?1 AND id > ?2 AND id <= ?3 ORDER BY id LIMIT ?4', userId, after, now, limit);
    return r.map((d) => ({ cursor: d.id, data: { albumId: d.album_id } }));
  },
};

const albums: Pass = {
  entity: 'AlbumV2',
  async fetch(db, userId, after, now, limit) {
    const r = await rows<Record<string, any>>(
      db,
      `SELECT al.* FROM albums al JOIN album_users au ON au.album_id = al.id AND au.user_id = ?1
       WHERE al.update_id > ?2 AND al.update_id <= ?3 ORDER BY al.update_id LIMIT ?4`,
      userId,
      after,
      now,
      limit,
    );
    return r.map((a) => ({
      cursor: a.update_id,
      data: {
        id: a.id,
        name: a.name,
        description: a.description ?? '',
        createdAt: a.created_at,
        updatedAt: a.updated_at,
        thumbnailAssetId: a.thumbnail_asset_id,
        isActivityEnabled: a.is_activity_enabled === 1,
        order: a.asset_order,
      },
    }));
  },
};

// ---- AlbumUsersV1 ----

const albumUserDeletes: Pass = {
  entity: 'AlbumUserDeleteV1',
  async fetch(db, userId, after, now, limit) {
    const r = await rows<{ id: string; album_id: string; user_id: string }>(
      db,
      `SELECT x.id, x.album_id, x.user_id FROM album_user_audit x ${MY_AUDIT} WHERE x.id > ?2 AND x.id <= ?3 ORDER BY x.id LIMIT ?4`,
      userId,
      after,
      now,
      limit,
    );
    return r.map((d) => ({ cursor: d.id, data: { albumId: d.album_id, userId: d.user_id } }));
  },
};

type AlbumUserLine = { cursor: string; album_id: string; user_id: string; role: string };
const mapAlbumUser = (r: AlbumUserLine) => ({ albumId: r.album_id, userId: r.user_id, role: r.role });

const albumUserBackfill = backfill<AlbumUserLine>(
  'AlbumUserBackfillV1',
  'AlbumUserV1',
  (ctx, albumId, after, end) =>
    ctx.db
      .prepare(
        `SELECT x.album_id, x.user_id, x.role, x.update_id AS cursor FROM album_users x
         JOIN album_users me ON me.album_id = x.album_id AND me.user_id = ?1
         WHERE x.album_id = ?2 AND x.update_id > ?3 AND x.update_id <= ?4 AND x.update_id <= ?5 ORDER BY x.update_id LIMIT ?6`,
      )
      .bind(ctx.userId, albumId, after, end, ctx.now, ctx.pageSize),
  mapAlbumUser,
);

const albumUsers: Pass = {
  entity: 'AlbumUserV1',
  async fetch(db, userId, after, now, limit) {
    const r = await rows<AlbumUserLine>(
      db,
      `SELECT album_id, user_id, role, update_id AS cursor FROM album_users
       WHERE album_id IN (${MY_ALBUMS}) AND update_id > ?2 AND update_id <= ?3 ORDER BY update_id LIMIT ?4`,
      userId,
      after,
      now,
      limit,
    );
    return r.map((u) => ({ cursor: u.cursor, data: mapAlbumUser(u) }));
  },
};

// ---- AlbumToAssetsV1 ----

const albumToAssetDeletes: Pass = {
  entity: 'AlbumToAssetDeleteV1',
  async fetch(db, userId, after, now, limit) {
    const r = await rows<{ id: string; album_id: string; asset_id: string }>(
      db,
      `SELECT x.id, x.album_id, x.asset_id FROM album_asset_audit x ${MY_AUDIT} WHERE x.id > ?2 AND x.id <= ?3 ORDER BY x.id LIMIT ?4`,
      userId,
      after,
      now,
      limit,
    );
    return r.map((d) => ({ cursor: d.id, data: { albumId: d.album_id, assetId: d.asset_id } }));
  },
};

type AlbumToAssetLine = { cursor: string; album_id: string; asset_id: string };
const mapAlbumToAsset = (r: AlbumToAssetLine) => ({ albumId: r.album_id, assetId: r.asset_id });

const albumToAssetBackfill = backfill<AlbumToAssetLine>(
  'AlbumToAssetBackfillV1',
  'AlbumToAssetV1',
  (ctx, albumId, after, end) =>
    ctx.db
      .prepare(
        `SELECT aa.album_id, aa.asset_id, aa.update_id AS cursor FROM album_assets aa
         JOIN album_users au ON au.album_id = aa.album_id AND au.user_id = ?1 JOIN assets a ON a.id = aa.asset_id
         WHERE aa.album_id = ?2 AND aa.update_id > ?3 AND aa.update_id <= ?4 AND aa.update_id <= ?5 AND ${VISIBLE_TO_ME}
         ORDER BY aa.update_id LIMIT ?6`,
      )
      .bind(ctx.userId, albumId, after, end, ctx.now, ctx.pageSize),
  mapAlbumToAsset,
);

const albumToAssets: Pass = {
  entity: 'AlbumToAssetV1',
  async fetch(db, userId, after, now, limit) {
    const r = await rows<AlbumToAssetLine>(
      db,
      `SELECT aa.album_id, aa.asset_id, aa.update_id AS cursor FROM album_assets aa JOIN album_users au ON au.album_id = aa.album_id AND au.user_id = ?1
       JOIN assets a ON a.id = aa.asset_id WHERE aa.update_id > ?2 AND aa.update_id <= ?3 AND ${VISIBLE_TO_ME} ORDER BY aa.update_id LIMIT ?4`,
      userId,
      after,
      now,
      limit,
    );
    return r.map((x) => ({ cursor: x.cursor, data: mapAlbumToAsset(x) }));
  },
};

// ---- AlbumAssetsV2 / AlbumAssetExifsV1: backfill, updates of known assets, then creates ----

type AssetLine = AssetRow & { cursor: string };
type ExifLine = ExifRow & { cursor: string };

/**
 * Immich getUpdates: assets (or EXIF rows) changed since the update checkpoint that sit in one of the user's albums
 * through an album_asset row the client already has (update_id <= the create checkpoint). Only runs once creates were acked.
 */
function updates<T extends { cursor: string }>(type: string, createType: string, sql: string, map: (row: T, ctx: SyncContext) => unknown): StreamPass {
  return {
    entity: type,
    async *stream(ctx) {
      const created = ctx.acks.get(createType);
      if (!created) return;
      for await (const page of pages<T>(ctx, ctx.acks.get(type)?.updateId ?? '', (after) =>
        ctx.db.prepare(sql).bind(ctx.userId, after, ctx.now, created.updateId, ctx.pageSize),
      )) {
        if (page.length) yield page.map((r) => line(type, map(r, ctx), `${type}|${r.cursor}`)).join('');
      }
    },
  };
}

/** Immich getCreates, preceded by a SyncAckV1 that moves the update checkpoint to now: creates carry current state. */
function creates<T extends { cursor: string }>(type: string, updateType: string, sql: string, map: (row: T, ctx: SyncContext) => unknown): StreamPass {
  return {
    entity: type,
    async *stream(ctx) {
      let first = true;
      for await (const page of pages<T>(ctx, ctx.acks.get(type)?.updateId ?? '', (after) => ctx.db.prepare(sql).bind(ctx.userId, after, ctx.now, ctx.pageSize))) {
        if (!page.length) continue;
        let text = '';
        if (first) text += line('SyncAckV1', {}, `${updateType}|${ctx.now}`);
        first = false;
        yield text + page.map((r) => line(type, map(r, ctx), `${type}|${r.cursor}`)).join('');
      }
    },
  };
}

const IN_MY_ALBUM_KNOWN = (assetCol: string) =>
  `EXISTS (SELECT 1 FROM album_assets aa JOIN album_users au ON au.album_id = aa.album_id AND au.user_id = ?1
   WHERE aa.asset_id = ${assetCol} AND aa.update_id <= ?4)`;

/** Backfill rows of one album, re-checking the caller's membership (?1) in the same statement. */
const backfillRows = (select: string, join: string) => (ctx: SyncContext, albumId: string, after: string, end: string) =>
  ctx.db
    .prepare(
      `SELECT ${select}, aa.update_id AS cursor FROM album_assets aa
       JOIN album_users au ON au.album_id = aa.album_id AND au.user_id = ?1
       JOIN assets a ON a.id = aa.asset_id ${join}
       WHERE aa.album_id = ?2 AND aa.update_id > ?3 AND aa.update_id <= ?4 AND aa.update_id <= ?5 AND ${VISIBLE_TO_ME}
       ORDER BY aa.update_id LIMIT ?6`,
    )
    .bind(ctx.userId, albumId, after, end, ctx.now, ctx.pageSize);

const albumAssetBackfill = backfill<AssetLine>('AlbumAssetBackfillV2', 'AlbumAssetCreateV2', backfillRows('a.*', ''), (r, ctx) =>
  albumAsset(r, ctx.userId),
);

const albumAssetUpdates = updates<AssetLine>(
  'AlbumAssetUpdateV2',
  'AlbumAssetCreateV2',
  `SELECT a.*, a.update_id AS cursor FROM assets a
   WHERE a.update_id > ?2 AND a.update_id <= ?3 AND ${VISIBLE_TO_ME} AND ${IN_MY_ALBUM_KNOWN('a.id')} ORDER BY a.update_id LIMIT ?5`,
  (r, ctx) => albumAsset(r, ctx.userId),
);

const albumAssetCreates = creates<AssetLine>(
  'AlbumAssetCreateV2',
  'AlbumAssetUpdateV2',
  `SELECT a.*, aa.update_id AS cursor FROM album_assets aa JOIN album_users au ON au.album_id = aa.album_id AND au.user_id = ?1
   JOIN assets a ON a.id = aa.asset_id WHERE aa.update_id > ?2 AND aa.update_id <= ?3 AND ${VISIBLE_TO_ME} ORDER BY aa.update_id LIMIT ?4`,
  (r, ctx) => albumAsset(r, ctx.userId),
);

const albumAssetExifBackfill = backfill<ExifLine>(
  'AlbumAssetExifBackfillV1',
  'AlbumAssetExifCreateV1',
  backfillRows('e.*', 'JOIN asset_exif e ON e.asset_id = aa.asset_id'),
  (r) => mapSyncExif(r),
);

const albumAssetExifUpdates = updates<ExifLine>(
  'AlbumAssetExifUpdateV1',
  'AlbumAssetExifCreateV1',
  `SELECT e.*, e.update_id AS cursor FROM asset_exif e JOIN assets a ON a.id = e.asset_id
   WHERE e.update_id > ?2 AND e.update_id <= ?3 AND ${VISIBLE_TO_ME} AND ${IN_MY_ALBUM_KNOWN('e.asset_id')} ORDER BY e.update_id LIMIT ?5`,
  (r) => mapSyncExif(r),
);

const albumAssetExifCreates = creates<ExifLine>(
  'AlbumAssetExifCreateV1',
  'AlbumAssetExifUpdateV1',
  `SELECT e.*, aa.update_id AS cursor FROM album_assets aa JOIN album_users au ON au.album_id = aa.album_id AND au.user_id = ?1
   JOIN assets a ON a.id = aa.asset_id JOIN asset_exif e ON e.asset_id = aa.asset_id
   WHERE aa.update_id > ?2 AND aa.update_id <= ?3 AND ${VISIBLE_TO_ME} ORDER BY aa.update_id LIMIT ?4`,
  (r) => mapSyncExif(r),
);

export const ALBUM_PASSES: Record<string, Array<Pass | StreamPass>> = {
  AlbumAssetsV2: [albumAssetBackfill, albumAssetUpdates, albumAssetCreates],
  AlbumsV2: [albumDeletes, albums],
  AlbumUsersV1: [albumUserDeletes, albumUserBackfill, albumUsers],
  AlbumToAssetsV1: [albumToAssetDeletes, albumToAssetBackfill, albumToAssets],
  AlbumAssetExifsV1: [albumAssetExifBackfill, albumAssetExifUpdates, albumAssetExifCreates],
};
