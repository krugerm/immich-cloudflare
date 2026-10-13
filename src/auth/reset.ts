import { type Context, Hono } from 'hono';
import type { AppEnv } from '../app';
import { getSystemConfig } from '../config/store';
import { commit } from '../db/changes';
import type { UserRow } from '../db/rows';
import { ImmichError } from '../http/errors';
import { jsonObject } from '../http/validate';
import { disconnectSessions } from '../realtime/emit';
import { getUserByEmail, userUpdate } from '../users/repo';
import { hashPassword } from './password';
import { mailers } from './reset-mail';

// Self-service password reset by email (not in Immich, which only has admin resets). The email link carries a random
// token in its fragment; only SHA-256(token) is stored.

export const RESET_TTL_MS = 30 * 60_000;
const MAX_OPEN_TOKENS = 3;
// Per-user send limits, checked in D1. The Workers rate limiter is per location and eventually consistent, so it is
// only a first filter against one client hammering the endpoint.
const COOLDOWN_MS = 60_000;
const HOURLY_MAX = 5;
const HOUR_MS = 60 * 60_000;
const MIN_PASSWORD = 8; // ChangePasswordDto.newPassword minLength
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url without padding
const INVALID = 'Invalid or expired link';
const DISABLED = 'Password login is disabled';

export const passwordResetRoutes = new Hono<AppEnv>();

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Hex(s: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The link origin: the configured external domain without any user:password part, else the request origin. */
export function linkOrigin(externalDomain: string, requestOrigin: string): string {
  if (!externalDomain) return requestOrigin;
  try {
    return new URL(externalDomain).origin;
  } catch {
    return requestOrigin;
  }
}

async function resetConfig(db: D1Database): Promise<{ enabled: boolean; externalDomain: string }> {
  const config = await getSystemConfig(db);
  return { enabled: config.passwordLogin.enabled, externalDomain: config.server.externalDomain };
}

// Background work (token insert and email) runs after the 204 so the response time does not depend on whether the
// account exists. Tests await it through settleResetWork().
const pending = new Set<Promise<void>>();

function background(c: Context<AppEnv>, work: Promise<void>): void {
  const p: Promise<void> = work
    .catch((err) => console.error('password reset request failed', err))
    .finally(() => pending.delete(p));
  pending.add(p);
  c.executionCtx.waitUntil(p);
}

export async function settleResetWork(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending]);
}

async function issueAndSend(env: Env, user: UserRow, token: string, tokenHash: string, origin: string): Promise<void> {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const hourAgo = new Date(now - HOUR_MS).toISOString();
  const [insert] = await env.DB.batch([
    // One statement checks the per-user windows and inserts, so concurrent requests cannot both pass the check.
    env.DB.prepare(
      `INSERT INTO password_resets (token_hash, user_id, created_at, expires_at)
       SELECT ?1, ?2, ?3, ?4
       WHERE NOT EXISTS (SELECT 1 FROM password_resets WHERE user_id = ?2 AND created_at > ?5)
         AND (SELECT count(*) FROM password_resets WHERE user_id = ?2 AND created_at > ?6) < ?7`,
    ).bind(tokenHash, user.id, nowIso, new Date(now + RESET_TTL_MS).toISOString(), new Date(now - COOLDOWN_MS).toISOString(), hourAgo, HOURLY_MAX),
    // Only the newest MAX_OPEN_TOKENS stay usable; older open ones expire now. Rows stay for an hour so the hourly
    // count sees them, then go.
    env.DB.prepare(
      `UPDATE password_resets SET expires_at = ?2 WHERE user_id = ?1 AND used_at IS NULL AND expires_at > ?2
         AND token_hash NOT IN (SELECT token_hash FROM password_resets WHERE user_id = ?1 AND used_at IS NULL AND expires_at > ?2
                                ORDER BY created_at DESC, rowid DESC LIMIT ?3)`,
    ).bind(user.id, nowIso, MAX_OPEN_TOKENS),
    env.DB.prepare('DELETE FROM password_resets WHERE user_id = ?1 AND created_at <= ?2').bind(user.id, hourAgo),
  ]);
  if (insert.meta.changes !== 1) return; // within the cooldown or over the hourly limit
  await mailers.create(env).send(user.email, `${origin}/reset-password#token=${token}`, user.name);
}

/**
 * Always 204 for a well-formed email. Rate limited by client IP and by email (RESET_LIMITER), then per user in D1
 * (one token per 60 s, five per hour); over any limit, or for an unknown, inactive or password-less account,
 * nothing is sent. The lookup and token hashing run either way.
 */
passwordResetRoutes.post('/auth/password-reset/request', async (c) => {
  const config = await resetConfig(c.env.DB);
  if (!config.enabled) throw new ImmichError(400, DISABLED);
  const body = await jsonObject(c.req.raw);
  const email = body.email;
  if (typeof email !== 'string' || email.length > 254 || !EMAIL_RE.test(email)) throw new ImmichError(400, 'email must be a valid email address');
  const lower = email.toLowerCase();
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  const [byIp, byEmail] = await Promise.all([
    c.env.RESET_LIMITER.limit({ key: `ip:${ip}` }),
    c.env.RESET_LIMITER.limit({ key: `email:${lower}` }),
  ]);
  const user = await getUserByEmail(c.env.DB, lower);
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  if (byIp.success && byEmail.success && user && user.status === 'active' && user.password_hash) {
    const origin = linkOrigin(config.externalDomain, new URL(c.req.url).origin);
    background(c, issueAndSend(c.env, user, token, tokenHash, origin));
  }
  return c.body(null, 204);
});

/**
 * Sets a new password from a valid token and ends every session. API keys are kept, as Immich keeps them on a
 * password change (owner decision, 2026-10-13). The token is claimed on its own first (UPDATE … RETURNING, so of two
 * concurrent confirms only one gets the row); then one D1 transaction updates the user (tracked, so sync sees it) and
 * deletes the user's other tokens, sessions and login lockout counter. The deleted sessions' sockets close afterwards.
 */
passwordResetRoutes.post('/auth/password-reset/confirm', async (c) => {
  if (!(await resetConfig(c.env.DB)).enabled) throw new ImmichError(400, DISABLED);
  const body = await jsonObject(c.req.raw);
  const token = body.token;
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw new ImmichError(400, INVALID);
  const tokenHash = await sha256Hex(token);
  const db = c.env.DB;
  const valid = `token_hash = ?1 AND used_at IS NULL AND expires_at > ?2
    AND user_id IN (SELECT id FROM users WHERE deleted_at IS NULL AND status = 'active')`;

  // Cheap read first, so an invalid link is rejected before the password is hashed.
  if (!(await db.prepare(`SELECT 1 AS ok FROM password_resets WHERE ${valid}`).bind(tokenHash, new Date().toISOString()).first('ok'))) {
    throw new ImmichError(400, INVALID);
  }
  const password = body.password;
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw new ImmichError(400, `password must be at least ${MIN_PASSWORD} characters`);
  }
  const passwordHash = await hashPassword(password);

  const userId = await db
    .prepare(`UPDATE password_resets SET used_at = ?2 WHERE ${valid} RETURNING user_id`)
    .bind(tokenHash, new Date().toISOString())
    .first<string>('user_id');
  if (!userId) throw new ImmichError(400, INVALID);

  const results = await commit(db, [
    userUpdate(userId, { password_hash: passwordHash, should_change_password: 0 }),
    db.prepare('DELETE FROM password_resets WHERE user_id = ?1 AND token_hash != ?2').bind(userId, tokenHash),
    db.prepare("DELETE FROM login_failures WHERE email = 'login:' || (SELECT lower(email) FROM users WHERE id = ?1)").bind(userId),
    db.prepare('SELECT id FROM sessions WHERE user_id = ?1').bind(userId),
    db.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(userId),
  ]);
  const deleted = (results[results.length - 2].results ?? []) as Array<{ id: string }>;
  c.executionCtx.waitUntil(disconnectSessions(c.env, userId, deleted.map((s) => s.id)));
  return c.body(null, 204);
});
