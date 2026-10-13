import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../app';
import type { SessionRow, UserRow } from '../db/rows';
import { ImmichError } from '../http/errors';
import { isGranted, requiredPermission } from './permissions';

export interface AuthContext {
  user: UserRow;
  /**
   * For API-key requests this is a placeholder: its id is `api-key:<key id>`, which matches no `sessions` row,
   * so session-keyed reads find nothing and session-keyed writes fail their foreign key. Check `apiKey` first.
   */
  session: SessionRow;
  /** Set when the request authenticated with `x-api-key` / `?apiKey=` instead of a session token. */
  apiKey?: { id: string; name: string; permissions: string[] };
  /** The session was unlocked with the PIN code and the unlock has not expired (Immich's hasElevatedPermission). */
  hasElevatedPermission?: boolean;
}

const hex = (buf: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(value: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) try {
      return decodeURIComponent(v.join('='));
    } catch {
      return null;
    }
  }
  return null;
}

export function extractToken(req: Request): string | null {
  const h = req.headers;
  const auth = h.get('authorization');
  const bearer = auth?.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : null;
  return (
    h.get('x-immich-user-token') ||
    h.get('x-immich-session-token') ||
    new URL(req.url).searchParams.get('sessionKey') ||
    bearer ||
    readCookie(h.get('cookie'), 'immich_access_token') ||
    null
  );
}

export async function createSession(db: D1Database, userId: string, deviceType: string, deviceOs: string) {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const now = new Date().toISOString();
  const session: SessionRow = {
    id: crypto.randomUUID(),
    user_id: userId,
    token_sha256: await sha256Hex(token),
    device_type: deviceType,
    device_os: deviceOs,
    reset_at: null,
    created_at: now,
    updated_at: now,
    pin_expires_at: null,
    expires_at: null,
    parent_id: null,
    is_pending_sync_reset: 0,
  };
  await db
    .prepare(
      'INSERT INTO sessions (id, user_id, token_sha256, device_type, device_os, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)',
    )
    .bind(session.id, userId, session.token_sha256, deviceType, deviceOs, now)
    .run();
  return { token, session };
}

const SESSION_COLUMNS = [
  'id', 'user_id', 'token_sha256', 'device_type', 'device_os', 'reset_at', 'created_at', 'updated_at',
  'pin_expires_at', 'expires_at', 'parent_id', 'is_pending_sync_reset',
] as const;
const PIN_SLIDE_MS = 5 * 60_000;

export async function findSession(db: D1Database, token: string): Promise<AuthContext | null> {
  const now = new Date();
  const row = await db
    .prepare(
      `SELECT ${SESSION_COLUMNS.map((k) => `s.${k} AS s_${k}`).join(', ')}, u.*
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_sha256 = ?1 AND u.deleted_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > ?2)`,
    )
    .bind(await sha256Hex(token), now.toISOString())
    .first<Record<string, any>>();
  if (!row) return null;
  const session = {} as Record<string, unknown>;
  const user = {} as Record<string, unknown>;
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith('s_') && (SESSION_COLUMNS as readonly string[]).includes(k.slice(2))) session[k.slice(2)] = v;
    else user[k] = v;
  }
  const auth: AuthContext = { session: session as unknown as SessionRow, user: user as unknown as UserRow, hasElevatedPermission: false };
  // Immich's PIN unlock: elevated while pin_expires_at is in the future, extended to now + 5 min when it is about to lapse.
  if (auth.session.pin_expires_at) {
    const expires = Date.parse(auth.session.pin_expires_at);
    auth.hasElevatedPermission = expires > now.getTime();
    if (auth.hasElevatedPermission && now.getTime() + PIN_SLIDE_MS > expires) {
      auth.session.pin_expires_at = new Date(now.getTime() + PIN_SLIDE_MS).toISOString();
      await db.prepare('UPDATE sessions SET pin_expires_at = ?2 WHERE id = ?1').bind(auth.session.id, auth.session.pin_expires_at).run();
    }
  }
  return auth;
}

/** `x-api-key` header, then `?apiKey=`, as Immich reads them. */
export function extractApiKey(req: Request): string | null {
  return req.headers.get('x-api-key') || new URL(req.url).searchParams.get('apiKey') || null;
}

export async function findApiKey(db: D1Database, secret: string): Promise<AuthContext | null> {
  const row = await db
    .prepare(
      `SELECT k.id AS k_id, k.name AS k_name, k.permissions AS k_permissions, k.created_at AS k_created_at, k.updated_at AS k_updated_at, u.*
       FROM api_keys k JOIN users u ON u.id = k.user_id
       WHERE k.key_sha256 = ?1 AND u.deleted_at IS NULL`,
    )
    .bind(await sha256Hex(secret))
    .first<Record<string, any>>();
  if (!row) return null;
  const { k_id, k_name, k_permissions, k_created_at, k_updated_at, ...user } = row;
  const session: SessionRow = {
    id: `api-key:${k_id}`,
    user_id: row.id,
    token_sha256: '',
    device_type: '',
    device_os: '',
    reset_at: null,
    created_at: k_created_at,
    updated_at: k_updated_at,
    pin_expires_at: null,
    expires_at: null,
    parent_id: null,
    is_pending_sync_reset: 0,
  };
  return {
    user: user as UserRow,
    session,
    apiKey: { id: k_id, name: k_name, permissions: JSON.parse(k_permissions) as string[] },
    hasElevatedPermission: false,
  };
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = extractToken(c.req.raw);
  let auth: AuthContext | null;
  if (token) {
    // A session token wins over an API key, and an invalid one is not retried as a key (Immich's validate order).
    auth = await findSession(c.env.DB, token);
    if (!auth) throw new ImmichError(401, 'Invalid user token');
  } else {
    const secret = extractApiKey(c.req.raw);
    if (!secret) throw new ImmichError(401, 'Invalid user token');
    auth = await findApiKey(c.env.DB, secret);
    if (!auth) throw new ImmichError(401, 'Invalid API key');
    const route = c.req.routePath.replace(/^\/api(?=\/)/, '');
    if (route.startsWith('/sync/')) throw new ImmichError(403, 'Sync endpoints cannot be used with API keys');
    const permission = requiredPermission(c.req.method, route);
    if (permission !== false && !isGranted([permission], auth.apiKey!.permissions)) {
      throw new ImmichError(403, `Missing required permission: ${permission}`);
    }
  }
  c.set('auth', auth);
  await next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  await requireAuth(c, async () => {});
  if (c.get('auth').user.is_admin !== 1) throw new ImmichError(403, 'Forbidden');
  await next();
};
