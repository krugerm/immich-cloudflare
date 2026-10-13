import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { jsonObject, optEnum, optString, optUuid, uuid } from '../albums/input';
import { requireAlbumAccess } from '../albums/repo';
import { requireAuth } from '../auth/session';
import type { UserRow } from '../db/rows';
import type { Dto } from '../gen/dto';
import { ImmichError } from '../http/errors';
import { mapUserShort } from '../users/extra';

export const activityRoutes = new Hono<AppEnv>();

interface ActivityRow {
  id: string;
  album_id: string;
  user_id: string;
  asset_id: string | null;
  comment: string | null;
  is_liked: number;
  created_at: string;
}

const SELECT = `SELECT act.id AS act_id, act.album_id, act.asset_id, act.comment, act.is_liked, act.created_at AS act_created_at, u.*
  FROM activities act JOIN users u ON u.id = act.user_id AND u.deleted_at IS NULL LEFT JOIN assets a ON a.id = act.asset_id`;

function mapActivity(row: Record<string, any>): Dto<'ActivityResponseDto'> {
  const { act_id, album_id, asset_id, comment, is_liked, act_created_at, ...user } = row;
  return {
    id: act_id,
    assetId: asset_id,
    createdAt: act_created_at,
    comment,
    type: is_liked ? 'like' : 'comment',
    user: mapUserShort(user as UserRow),
  };
}

activityRoutes.get('/activities', requireAuth, async (c) => {
  const q = c.req.query();
  const albumId = uuid(q.albumId, 'albumId');
  const assetId = optUuid(q.assetId, 'assetId');
  const userId = optUuid(q.userId, 'userId');
  const level = optEnum(q.level, 'level', ['album', 'asset'] as const);
  const type = optEnum(q.type, 'type', ['comment', 'like'] as const);
  await requireAlbumAccess(c, albumId, 'read');
  // album-level activities have no asset (a.* NULL); asset activities skip trashed and locked assets
  const where = ['act.album_id = ?1', 'a.deleted_at IS NULL', "(a.id IS NULL OR a.visibility != 'locked')"];
  const binds: unknown[] = [albumId];
  const add = (sql: string, v: unknown) => {
    binds.push(v);
    where.push(sql.replace('?', `?${binds.length}`));
  };
  if (userId) add('act.user_id = ?', userId);
  if (level === 'album') where.push('act.asset_id IS NULL');
  else if (assetId) add('act.asset_id = ?', assetId);
  if (type) where.push(`act.is_liked = ${type === 'like' ? 1 : 0}`);
  const { results } = await c.env.DB.prepare(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY act.created_at ASC, act.rowid ASC`).bind(...binds).all<Record<string, any>>();
  return c.json(results.map(mapActivity));
});

activityRoutes.get('/activities/statistics', requireAuth, async (c) => {
  const albumId = uuid(c.req.query('albumId'), 'albumId');
  const assetId = optUuid(c.req.query('assetId'), 'assetId');
  await requireAlbumAccess(c, albumId, 'read');
  const row = await c.env.DB.prepare(
    `SELECT count(*) FILTER (WHERE act.is_liked = 0) AS comments, count(*) FILTER (WHERE act.is_liked = 1) AS likes
     FROM activities act JOIN users u ON u.id = act.user_id AND u.deleted_at IS NULL LEFT JOIN assets a ON a.id = act.asset_id
     WHERE act.album_id = ?1 AND (?2 IS NULL OR act.asset_id = ?2)
       AND ((a.deleted_at IS NULL AND a.visibility != 'locked') OR a.id IS NULL)`,
  )
    .bind(albumId, assetId ?? null)
    .first<{ comments: number; likes: number }>();
  return c.json({ comments: row?.comments ?? 0, likes: row?.likes ?? 0 });
});

activityRoutes.post('/activities', requireAuth, async (c) => {
  const db = c.env.DB;
  const userId = c.get('auth').user.id;
  const body = await jsonObject(c);
  const albumId = uuid(body.albumId, 'albumId');
  const assetId = optUuid(body.assetId, 'assetId') ?? null;
  const type = optEnum(body.type, 'type', ['comment', 'like'] as const);
  if (!type) throw new ImmichError(400, 'type is required');
  const comment = optString(body.comment, 'comment');
  if (type === 'comment' && !comment?.trim()) throw new ImmichError(400, 'Comment is required when type is COMMENT');
  if (type === 'like' && comment) throw new ImmichError(400, 'Comment must not be provided when type is not COMMENT');

  // Immich ActivityAccess.checkCreateAccess: a member of an album with activity enabled
  const allowed = await db
    .prepare('SELECT 1 AS ok FROM albums al JOIN album_users au ON au.album_id = al.id AND au.user_id = ?2 WHERE al.id = ?1 AND al.is_activity_enabled = 1')
    .bind(albumId, userId)
    .first();
  if (!allowed) throw new ImmichError(400, 'Not found or no activity.create access');
  if (assetId && !(await db.prepare('SELECT 1 AS ok FROM album_assets WHERE album_id = ?1 AND asset_id = ?2').bind(albumId, assetId).first())) {
    throw new ImmichError(400, 'Asset is not in the album');
  }

  if (type === 'like') {
    const existing = await db
      .prepare(`${SELECT} WHERE act.album_id = ?1 AND act.user_id = ?2 AND act.asset_id IS ?3 AND act.is_liked = 1`)
      .bind(albumId, userId, assetId)
      .first<Record<string, any>>();
    if (existing) return c.json(mapActivity(existing), 200);
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db
    .prepare('INSERT INTO activities (id, album_id, user_id, asset_id, comment, is_liked, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)')
    .bind(id, albumId, userId, assetId, type === 'comment' ? comment! : null, type === 'like' ? 1 : 0, now)
    .run();
  const row = await db.prepare(`${SELECT} WHERE act.id = ?1`).bind(id).first<Record<string, any>>();
  return c.json(mapActivity(row!), 201);
});

activityRoutes.delete('/activities/:id', requireAuth, async (c) => {
  const db = c.env.DB;
  const id = uuid(c.req.param('id'), 'id');
  const userId = c.get('auth').user.id;
  // Immich ActivityDelete: the author, or the owner of the album
  const row = await db
    .prepare(
      `SELECT act.id FROM activities act WHERE act.id = ?1 AND (act.user_id = ?2 OR EXISTS (
         SELECT 1 FROM album_users au WHERE au.album_id = act.album_id AND au.user_id = ?2 AND au.role = 'owner'))`,
    )
    .bind(id, userId)
    .first<ActivityRow>();
  if (!row) throw new ImmichError(400, 'Not found or no activity.delete access');
  await db.prepare('DELETE FROM activities WHERE id = ?1').bind(id).run();
  return c.body(null, 204);
});
