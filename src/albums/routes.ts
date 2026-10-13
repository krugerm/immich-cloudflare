import { Hono, type Context } from 'hono';
import type { AppEnv } from '../app';
import { shareableAssetIds } from '../access/assets';
import { requireAuth } from '../auth/session';
import { commit, tracked, type Tracked } from '../db/changes';
import type { Dto } from '../gen/dto';
import { ImmichError } from '../http/errors';
import { getSharedLink, requireAuthOrSharedLink } from '../shared-links/auth';
import { getUserById } from '../users/repo';
import { jsonObject, optBool, optEnum, optNullableString, optString, optUuid, queryBool, uuid, uuidArray } from './input';
import {
  albumAssetIds,
  albumMembers,
  albumRole,
  allowedAlbumIds,
  bumpAlbum,
  commitChunked,
  deleteAlbumStatements,
  findAlbumOrFail,
  getAlbum,
  insertAlbumAsset,
  insertAlbumUser,
  mapAlbums,
  removeAlbumAsset,
  removeAlbumUser,
  repairThumbnails,
  requireAlbumAccess,
  roleAllows,
  type AlbumRole,
  type AlbumRow,
} from './repo';

export const albumRoutes = new Hono<AppEnv>();

type BulkId = Dto<'BulkIdResponseDto'>;

function defaultOrder(preferences: string): 'asc' | 'desc' {
  try {
    return JSON.parse(preferences)?.albums?.defaultAssetOrder === 'asc' ? 'asc' : 'desc';
  } catch {
    return 'desc';
  }
}

/** Loads the album after a thumbnail repair, mapped for the caller. */
async function albumResponse(c: Context<AppEnv>, id: string, opts: { contributors?: boolean } = {}) {
  const db = c.env.DB;
  await repairThumbnails(db, [id]);
  const album = await findAlbumOrFail(db, id);
  const viewer = getSharedLink(c)?.owner.id ?? c.get('auth').user.id;
  const [mapped] = await mapAlbums(db, [album], viewer, opts);
  return mapped;
}

const SHARED_ALBUM = `(EXISTS (SELECT 1 FROM album_users o WHERE o.album_id = al.id AND o.role != 'owner')
  OR EXISTS (SELECT 1 FROM shared_links l WHERE l.album_id = al.id))`;

albumRoutes.get('/albums', requireAuth, async (c) => {
  const db = c.env.DB;
  const userId = c.get('auth').user.id;
  const q = c.req.query();
  const assetId = optUuid(q.assetId, 'assetId');
  const id = optUuid(q.id, 'id');
  const isOwned = queryBool(q.isOwned, 'isOwned');
  const isShared = queryBool(q.isShared, 'isShared');
  const where = ['1 = 1'];
  const binds: unknown[] = [userId];
  if (assetId) {
    binds.push(assetId);
    where.push(`EXISTS (SELECT 1 FROM album_assets x WHERE x.album_id = al.id AND x.asset_id = ?${binds.length})`);
  } else {
    if (isOwned === true) where.push("me.role = 'owner'");
    if (isOwned === false) where.push("me.role != 'owner'");
    if (isShared !== undefined) where.push(isShared ? SHARED_ALBUM : `NOT ${SHARED_ALBUM}`);
    if (id) {
      binds.push(id);
      where.push(`al.id = ?${binds.length}`);
    }
    if (q.name) {
      binds.push(q.name);
      where.push(`al.name = ?${binds.length}`);
    }
  }
  const sql = `SELECT al.* FROM albums al JOIN album_users me ON me.album_id = al.id AND me.user_id = ?1 WHERE ${where.join(' AND ')} ORDER BY al.created_at DESC`;
  let { results } = await db.prepare(sql).bind(...binds).all<AlbumRow>();
  if (await repairThumbnails(db, results.map((a) => a.id))) ({ results } = await db.prepare(sql).bind(...binds).all<AlbumRow>());
  return c.json(await mapAlbums(db, results, userId));
});

albumRoutes.get('/albums/statistics', requireAuth, async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT
       count(*) FILTER (WHERE me.role = 'owner') AS owned,
       count(*) FILTER (WHERE ${SHARED_ALBUM}) AS shared,
       count(*) FILTER (WHERE me.role = 'owner' AND NOT ${SHARED_ALBUM}) AS notShared
     FROM albums al JOIN album_users me ON me.album_id = al.id AND me.user_id = ?1`,
  )
    .bind(c.get('auth').user.id)
    .first<{ owned: number; shared: number; notShared: number }>();
  return c.json({ owned: row?.owned ?? 0, shared: row?.shared ?? 0, notShared: row?.notShared ?? 0 });
});

albumRoutes.post('/albums', requireAuth, async (c) => {
  const db = c.env.DB;
  const auth = c.get('auth');
  const body = await jsonObject(c);
  const name = optString(body.albumName, 'albumName');
  if (name === undefined) throw new ImmichError(400, 'albumName is required');
  const description = optNullableString(body.description, 'description') || null;
  if (body.albumUsers !== undefined && !Array.isArray(body.albumUsers)) throw new ImmichError(400, 'albumUsers must be an array');
  const members = new Map<string, AlbumRole>();
  for (const [i, u] of ((body.albumUsers as unknown[]) ?? []).entries()) {
    if (!u || typeof u !== 'object') throw new ImmichError(400, `albumUsers[${i}] must be an object`);
    const userId = uuid((u as any).userId, `albumUsers[${i}].userId`);
    const role = optEnum((u as any).role, `albumUsers[${i}].role`, ['editor', 'viewer', 'owner'] as const);
    if (!role) throw new ImmichError(400, `albumUsers[${i}].role is required`);
    if (userId === auth.user.id) continue;
    if (role === 'owner') throw new ImmichError(400, 'Cannot add another owner');
    members.set(userId, role);
  }
  const assetIds = body.assetIds === undefined ? [] : uuidArray(body.assetIds, 'assetIds');
  for (const userId of members.keys()) {
    if (!(await getUserById(db, userId))) throw new ImmichError(400, 'Invalid user');
  }
  const allowed = await shareableAssetIds(db, auth.user.id, assetIds);
  const added = [...new Set(assetIds)].filter((a) => allowed.has(a));
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await commit(db, [
    tracked(
      `INSERT INTO albums (id, name, description, thumbnail_asset_id, asset_order, is_activity_enabled, created_at, updated_at, update_id)
       VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?6, :cursor)`,
      id,
      name,
      description,
      added[0] ?? null,
      defaultOrder(auth.user.preferences),
      now,
    ),
    insertAlbumUser(id, auth.user.id, 'owner', now),
    ...[...members].map(([userId, role]) => insertAlbumUser(id, userId, role, now)),
  ]);
  await commitChunked(db, added.map((assetId) => insertAlbumAsset(id, assetId, now)));
  const [album] = await mapAlbums(db, [(await getAlbum(db, id))!], auth.user.id);
  return c.json(album, 201);
});

albumRoutes.put('/albums/assets', requireAuth, async (c) => {
  const db = c.env.DB;
  const userId = c.get('auth').user.id;
  const body = await jsonObject(c);
  const albumIds = uuidArray(body.albumIds, 'albumIds');
  const assetIds = uuidArray(body.assetIds, 'assetIds');
  const albums = await allowedAlbumIds(db, userId, albumIds, 'assetCreate');
  if (albums.size === 0) return c.json({ success: false, error: 'no_permission' });
  const assets = await shareableAssetIds(db, userId, assetIds);
  if (assets.size === 0) return c.json({ success: false, error: 'no_permission' });
  const now = new Date().toISOString();
  let success = false;
  for (const albumId of albums) {
    const existing = await albumAssetIds(db, albumId, [...assets]);
    const fresh = [...assets].filter((a) => !existing.has(a));
    if (fresh.length === 0) continue;
    success = true;
    await commitChunked(
      db,
      fresh.map((assetId) => insertAlbumAsset(albumId, assetId, now)),
      [bumpAlbum(albumId, now, ', thumbnail_asset_id = coalesce(thumbnail_asset_id, ?3)', fresh[0])],
    );
  }
  return c.json(success ? { success: true } : { success: false, error: 'duplicate' });
});

albumRoutes.get('/albums/:id', requireAuthOrSharedLink(), async (c) => {
  const id = uuid(c.req.param('id'), 'id');
  await requireAlbumAccess(c, id, 'read');
  const album = await albumResponse(c, id, { contributors: true });
  if (getSharedLink(c)) Object.assign(album, { shared: true, hasSharedLink: true });
  return c.json(album);
});

albumRoutes.get('/albums/:id/map-markers', requireAuthOrSharedLink(), async (c) => {
  const id = uuid(c.req.param('id'), 'id');
  await requireAlbumAccess(c, id, 'read');
  const shared = getSharedLink(c);
  if (shared && !shared.link.show_metadata) return c.json([]);
  const { results } = await c.env.DB.prepare(
    `SELECT a.id, e.latitude AS lat, e.longitude AS lon, e.city, e.state, e.country
     FROM album_assets aa JOIN assets a ON a.id = aa.asset_id JOIN asset_exif e ON e.asset_id = a.id
     WHERE aa.album_id = ?1 AND a.deleted_at IS NULL AND a.visibility != 'locked' AND e.latitude IS NOT NULL AND e.longitude IS NOT NULL
     ORDER BY a.file_created_at DESC`,
  )
    .bind(id)
    .all<Dto<'MapMarkerResponseDto'>>();
  return c.json(results);
});

albumRoutes.patch('/albums/:id', requireAuth, async (c) => {
  const db = c.env.DB;
  const id = uuid(c.req.param('id'), 'id');
  const body = await jsonObject(c);
  const name = optString(body.albumName, 'albumName');
  const description = optNullableString(body.description, 'description');
  const thumbnail = optUuid(body.albumThumbnailAssetId, 'albumThumbnailAssetId');
  const isActivityEnabled = optBool(body.isActivityEnabled, 'isActivityEnabled');
  const order = optEnum(body.order, 'order', ['asc', 'desc'] as const);
  await requireAlbumAccess(c, id, 'update');
  await findAlbumOrFail(db, id);
  if (thumbnail && (await albumAssetIds(db, id, [thumbnail])).size === 0) throw new ImmichError(400, 'Invalid album thumbnail');
  const sets: string[] = [];
  const binds: unknown[] = [];
  const set = (col: string, v: unknown) => {
    binds.push(v);
    sets.push(`, ${col} = ?${binds.length + 2}`);
  };
  if (name !== undefined) set('name', name);
  if (description !== undefined) set('description', description || null);
  if (thumbnail !== undefined) set('thumbnail_asset_id', thumbnail);
  if (isActivityEnabled !== undefined) set('is_activity_enabled', isActivityEnabled ? 1 : 0);
  if (order !== undefined) set('asset_order', order);
  await commit(db, [bumpAlbum(id, new Date().toISOString(), sets.join(''), ...binds)]);
  return c.json(await albumResponse(c, id));
});

albumRoutes.delete('/albums/:id', requireAuth, async (c) => {
  const db = c.env.DB;
  const id = uuid(c.req.param('id'), 'id');
  await requireAlbumAccess(c, id, 'delete');
  const members = await albumMembers(db, id);
  await commit(db, deleteAlbumStatements(db, id, members.map((m) => m.user_id), new Date().toISOString()));
  return c.body(null, 204);
});

albumRoutes.put('/albums/:id/assets', requireAuth, async (c) => {
  const db = c.env.DB;
  const userId = c.get('auth').user.id;
  const id = uuid(c.req.param('id'), 'id');
  const ids = uuidArray((await jsonObject(c)).ids, 'ids');
  const album = await findAlbumOrFail(db, id);
  await requireAlbumAccess(c, id, 'assetCreate');
  const existing = await albumAssetIds(db, id, ids);
  const allowed = await shareableAssetIds(db, userId, ids.filter((a) => !existing.has(a)));
  const results: BulkId[] = [];
  for (const assetId of ids) {
    if (existing.has(assetId)) results.push({ id: assetId, success: false, error: 'duplicate' });
    else if (!allowed.has(assetId)) results.push({ id: assetId, success: false, error: 'no_permission' });
    else {
      existing.add(assetId);
      results.push({ id: assetId, success: true });
    }
  }
  const added = results.filter((r) => r.success).map((r) => r.id);
  if (added.length) {
    const now = new Date().toISOString();
    await commitChunked(
      db,
      added.map((assetId) => insertAlbumAsset(id, assetId, now)),
      [bumpAlbum(id, now, ', thumbnail_asset_id = ?3', album.thumbnail_asset_id ?? added[0])],
    );
  }
  return c.json(results);
});

albumRoutes.delete('/albums/:id/assets', requireAuth, async (c) => {
  const db = c.env.DB;
  const userId = c.get('auth').user.id;
  const id = uuid(c.req.param('id'), 'id');
  const ids = uuidArray((await jsonObject(c)).ids, 'ids');
  await requireAlbumAccess(c, id, 'assetDelete');
  const album = await findAlbumOrFail(db, id);
  const existing = await albumAssetIds(db, id, ids);
  const canAlwaysRemove = roleAllows(await albumRole(db, id, userId), 'delete');
  const allowed = canAlwaysRemove ? existing : await shareableAssetIds(db, userId, [...existing]);
  const results: BulkId[] = [];
  for (const assetId of ids) {
    if (!existing.has(assetId)) results.push({ id: assetId, success: false, error: 'not_found' });
    else if (!allowed.has(assetId)) results.push({ id: assetId, success: false, error: 'no_permission' });
    else {
      existing.delete(assetId);
      results.push({ id: assetId, success: true });
    }
  }
  const removed = results.filter((r) => r.success).map((r) => r.id);
  if (removed.length) {
    const now = new Date().toISOString();
    const statements = removed.flatMap((assetId) => removeAlbumAsset(db, id, assetId, now));
    for (let i = 0; i < statements.length; i += 400) await commit(db, statements.slice(i, i + 400));
    if (album.thumbnail_asset_id && removed.includes(album.thumbnail_asset_id)) await repairThumbnails(db, [id]);
  }
  return c.json(results);
});

albumRoutes.put('/albums/:id/users', requireAuth, async (c) => {
  const db = c.env.DB;
  const id = uuid(c.req.param('id'), 'id');
  const body = await jsonObject(c);
  if (!Array.isArray(body.albumUsers) || body.albumUsers.length === 0) throw new ImmichError(400, 'albumUsers must be a non-empty array');
  const wanted = body.albumUsers.map((u: any, i: number) => {
    if (!u || typeof u !== 'object') throw new ImmichError(400, `albumUsers[${i}] must be an object`);
    return {
      userId: uuid(u.userId, `albumUsers[${i}].userId`),
      role: optEnum(u.role, `albumUsers[${i}].role`, ['editor', 'viewer', 'owner'] as const) ?? 'editor',
    };
  });
  await requireAlbumAccess(c, id, 'share');
  await findAlbumOrFail(db, id);
  const members = new Set((await albumMembers(db, id)).map((m) => m.user_id));
  const now = new Date().toISOString();
  const writes: Tracked[] = [];
  for (const { userId, role } of wanted) {
    if (role === 'owner') throw new ImmichError(400, 'Cannot add another owner');
    if (members.has(userId)) continue;
    if (!(await getUserById(db, userId))) throw new ImmichError(400, 'Invalid user');
    members.add(userId);
    // album_user_after_insert: a new non-owner member bumps the album, so the member receives it as AlbumV2
    writes.push(insertAlbumUser(id, userId, role, now), bumpAlbum(id, now));
  }
  if (writes.length) await commit(db, writes);
  return c.json(await albumResponse(c, id));
});

albumRoutes.put('/albums/:id/user/:userId', requireAuth, async (c) => {
  const db = c.env.DB;
  const id = uuid(c.req.param('id'), 'id');
  const userId = uuid(c.req.param('userId'), 'userId');
  const role = optEnum((await jsonObject(c)).role, 'role', ['editor', 'viewer', 'owner'] as const);
  if (!role) throw new ImmichError(400, 'role is required');
  await requireAlbumAccess(c, id, 'share');
  await findAlbumOrFail(db, id);
  const target = await albumRole(db, id, userId);
  if (target === 'owner') throw new ImmichError(400, 'User is owner');
  if (role === 'owner') throw new ImmichError(400, 'Cannot add another owner');
  if (target) {
    await commit(db, [
      tracked('UPDATE album_users SET role = ?3, updated_at = ?4, update_id = :cursor WHERE album_id = ?1 AND user_id = ?2', id, userId, role, new Date().toISOString()),
    ]);
  }
  return c.body(null, 204);
});

albumRoutes.delete('/albums/:id/user/:userId', requireAuth, async (c) => {
  const db = c.env.DB;
  const self = c.get('auth').user.id;
  const id = uuid(c.req.param('id'), 'id');
  const param = c.req.param('userId');
  const userId = param === 'me' ? self : uuid(param, 'userId');
  await findAlbumOrFail(db, id);
  const members = await albumMembers(db, id);
  const target = members.find((m) => m.user_id === userId);
  if (!target) throw new ImmichError(400, 'Album not shared with user');
  if (target.role === 'owner' && members.filter((m) => m.role === 'owner').length === 1) throw new ImmichError(400, 'Cannot remove the last album owner');
  if (userId !== self) await requireAlbumAccess(c, id, 'share');
  await commit(db, removeAlbumUser(db, id, userId, new Date().toISOString()));
  return c.body(null, 204);
});
