import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { requireAuth, sha256Hex, type AuthContext } from '../auth/session';
import type { SessionRow } from '../db/rows';
import type { Dto } from '../gen/dto';
import { ImmichError } from '../http/errors';
import { readDto, uuidPathParam } from '../http/validate';
import { disconnectSessions } from '../realtime/emit';

export const sessionRoutes = new Hono<AppEnv>();

/** Never includes token_sha256. */
export function mapSession(s: SessionRow, currentId: string | null): Dto<'SessionResponseDto'> {
  return {
    id: s.id,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    ...(s.expires_at ? { expiresAt: s.expires_at } : {}),
    current: s.id === currentId,
    appVersion: null,
    deviceOS: s.device_os,
    deviceType: s.device_type,
    isPendingSyncReset: s.is_pending_sync_reset === 1,
  };
}

const COLUMNS = 'id, user_id, device_type, device_os, reset_at, created_at, updated_at, pin_expires_at, expires_at, parent_id, is_pending_sync_reset';

export async function listSessions(db: D1Database, userId: string, currentId: string | null) {
  const { results } = await db
    .prepare(
      `SELECT ${COLUMNS} FROM sessions WHERE user_id = ?1 AND (expires_at IS NULL OR expires_at > ?2) ORDER BY updated_at DESC, id`,
    )
    .bind(userId, new Date().toISOString())
    .all<SessionRow>();
  return results.map((s) => mapSession(s, currentId));
}

/** Immich's requireAccess for session.* permissions: the session must belong to the caller. */
async function ownSession(db: D1Database, auth: AuthContext, id: string, permission: string): Promise<SessionRow> {
  const s = await db.prepare(`SELECT ${COLUMNS} FROM sessions WHERE id = ?1 AND user_id = ?2`).bind(id, auth.user.id).first<SessionRow>();
  if (!s) throw new ImmichError(400, `Not found or no ${permission} access`);
  return s;
}

/**
 * Two statements for one batch (one D1 transaction): read the ids of every session of the user except `keepId`,
 * then delete them. DELETE … RETURNING would miss rows removed by the parent_id cascade before the scan reached
 * them. The caller disconnects exactly the ids read (the first result) after the commit.
 */
export function deleteOtherSessions(db: D1Database, userId: string, keepId: string): [D1PreparedStatement, D1PreparedStatement] {
  return [
    // descendants too: `keepId` itself goes by cascade when it is a child of a deleted session
    db
      .prepare(
        `WITH RECURSIVE d(id) AS (SELECT id FROM sessions WHERE user_id = ?1 AND id != ?2
           UNION SELECT s.id FROM sessions s JOIN d ON s.parent_id = d.id) SELECT id FROM d`,
      )
      .bind(userId, keepId),
    db.prepare('DELETE FROM sessions WHERE user_id = ?1 AND id != ?2').bind(userId, keepId),
  ];
}

/**
 * Deletes a session of the user and its descendants (which go by the parent_id cascade, so DELETE … RETURNING
 * would not list them). One batch, a single D1 transaction, reads the ids and deletes them, so nothing can be
 * created in between. Returns exactly the deleted ids, for the caller to disconnect after the commit.
 */
export async function deleteSessionTree(db: D1Database, userId: string, id: string): Promise<string[]> {
  const tree = `WITH RECURSIVE d(id) AS (SELECT id FROM sessions WHERE id = ?1 AND user_id = ?2
                  UNION SELECT s.id FROM sessions s JOIN d ON s.parent_id = d.id) SELECT id FROM d`;
  const [read] = await db.batch([db.prepare(tree).bind(id, userId), db.prepare(`DELETE FROM sessions WHERE id IN (${tree})`).bind(id, userId)]);
  return ((read.results ?? []) as Array<{ id: string }>).map((s) => s.id);
}

export function requireSessionToken(auth: AuthContext): void {
  if (auth.apiKey) throw new ImmichError(400, 'This endpoint can only be used with a session token');
}

sessionRoutes.get('/sessions', requireAuth, async (c) => {
  const { user, session } = c.get('auth');
  return c.json(await listSessions(c.env.DB, user.id, session.id));
});

/** A child session (Immich uses it for casting): deleted with its parent, optionally expiring after `duration` seconds. */
sessionRoutes.post('/sessions', requireAuth, async (c) => {
  const auth = c.get('auth');
  requireSessionToken(auth);
  const dto = await readDto(c, 'SessionCreateDto');
  // The DTO allows up to 2^53-1 seconds, past the largest JS Date (8.64e15 ms); such a duration cannot be stored.
  if (dto.duration && Date.now() + dto.duration * 1000 > 8.64e15) throw new ImmichError(400, 'duration is too large');
  const token = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const now = new Date();
  // A child never outlives its parent: a session that expires cannot mint one that does not (or expires later).
  const requested = dto.duration ? new Date(now.getTime() + dto.duration * 1000).toISOString() : null;
  const parentEnd = auth.session.expires_at;
  const expiresAt = parentEnd && (requested === null || requested > parentEnd) ? parentEnd : requested;
  const s: SessionRow = {
    id: crypto.randomUUID(),
    user_id: auth.user.id,
    token_sha256: await sha256Hex(token),
    device_type: dto.deviceType ?? '',
    device_os: dto.deviceOS ?? '',
    reset_at: null,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    pin_expires_at: null,
    expires_at: expiresAt,
    parent_id: auth.session.id,
    is_pending_sync_reset: 0,
  };
  await c.env.DB.prepare(
    `INSERT INTO sessions (id, user_id, token_sha256, device_type, device_os, created_at, updated_at, expires_at, parent_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8)`,
  )
    .bind(s.id, s.user_id, s.token_sha256, s.device_type, s.device_os, s.created_at, s.expires_at, s.parent_id)
    .run();
  return c.json({ ...mapSession(s, null), token }, 201);
});

/** Deletes every session of the caller except the current one (all of them for an API key). Checkpoints and child sessions cascade. */
sessionRoutes.delete('/sessions', requireAuth, async (c) => {
  const { user, session } = c.get('auth');
  const [read] = await c.env.DB.batch(deleteOtherSessions(c.env.DB, user.id, session.id));
  // stream H: close the realtime sockets of every deleted session
  c.executionCtx.waitUntil(disconnectSessions(c.env, user.id, ((read.results ?? []) as Array<{ id: string }>).map((s) => s.id)));
  return c.body(null, 204);
});

sessionRoutes.delete('/sessions/:id', requireAuth, async (c) => {
  const id = uuidPathParam(c);
  const { user } = c.get('auth');
  await ownSession(c.env.DB, c.get('auth'), id, 'authDevice.delete');
  // stream H: close the realtime sockets of the session and its descendants
  c.executionCtx.waitUntil(disconnectSessions(c.env, user.id, await deleteSessionTree(c.env.DB, user.id, id)));
  return c.body(null, 204);
});

sessionRoutes.put('/sessions/:id', requireAuth, async (c) => {
  const id = uuidPathParam(c);
  await ownSession(c.env.DB, c.get('auth'), id, 'session.update');
  const dto = await readDto(c, 'SessionUpdateDto');
  if (dto.isPendingSyncReset === undefined) throw new ImmichError(400, 'No fields to update');
  await c.env.DB.prepare('UPDATE sessions SET is_pending_sync_reset = ?2 WHERE id = ?1').bind(id, dto.isPendingSyncReset ? 1 : 0).run();
  const s = await ownSession(c.env.DB, c.get('auth'), id, 'session.update');
  return c.json(mapSession(s, null)); // Immich maps without the current id here
});

sessionRoutes.post('/sessions/:id/lock', requireAuth, async (c) => {
  const id = uuidPathParam(c);
  await ownSession(c.env.DB, c.get('auth'), id, 'session.lock');
  await c.env.DB.prepare('UPDATE sessions SET pin_expires_at = NULL WHERE id = ?1').bind(id).run();
  return c.body(null, 204);
});
