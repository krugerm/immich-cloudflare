import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { commit } from '../db/changes';
import type { UserRow } from '../db/rows';
import { ImmichError } from '../http/errors';
import { readDto } from '../http/validate';
import { disconnectSessions } from '../realtime/emit';
import { deleteOtherSessions, requireSessionToken } from '../sessions/routes';
import { mapUserAdmin } from '../users/map';
import { getUserAnyState, userUpdate } from '../users/repo';
import { clearAttempts, pinKey, reserveAttempt } from './lockout';
import { hashPassword, verifyPassword } from './password';
import { requireAuth } from './session';

// Password change, PIN codes, session lock/unlock and auth status (Immich auth.service.ts).

export const accountRoutes = new Hono<AppEnv>();

const UNLOCK_MS = 15 * 60_000;

const secretMatches = (input: string, hash: string | null) => (hash ? verifyPassword(input, hash) : Promise.resolve(false));

// A 6-digit PIN has 10^6 values, so checks are counted per user in login_failures (key `pin:<userId>`): each attempt is
// reserved before verifying, and past PIN_MAX_FAILURES within PIN_WINDOW_MS a check returns 429 unverified. Not in Immich.
export const PIN_MAX_FAILURES = 5;
const PIN_WINDOW_MS = 15 * 60_000;

/** Immich's validatePinCode: a PIN must exist, and either the password or the current PIN must match. Attempts count toward the lockout. */
async function validatePinCode(db: D1Database, user: UserRow, dto: { pinCode?: string; password?: string }): Promise<void> {
  if (!user.pin_code) throw new ImmichError(400, 'User does not have a PIN code');
  if (!dto.password && !dto.pinCode) throw new ImmichError(400, 'Either password or pinCode is required');
  const key = pinKey(user.id);
  if (!(await reserveAttempt(db, key, PIN_MAX_FAILURES, PIN_WINDOW_MS))) throw new ImmichError(429, 'Too many PIN code attempts');
  const ok = dto.password ? await secretMatches(dto.password, user.password_hash) : await secretMatches(dto.pinCode!, user.pin_code);
  if (!ok) throw new ImmichError(400, dto.password ? 'Wrong password' : 'Wrong PIN code');
  await clearAttempts(db, key);
}

/** Immich 3.3 deletes every other session on a password change; its listener ignores `invalidateSessions`. */
accountRoutes.post('/auth/change-password', requireAuth, async (c) => {
  const { user, session } = c.get('auth');
  const dto = await readDto(c, 'ChangePasswordDto');
  if (!(await secretMatches(dto.password, user.password_hash))) throw new ImmichError(400, 'Wrong password');
  const [readSessions, deleteSessions] = deleteOtherSessions(c.env.DB, user.id, session.id);
  const results = await commit(c.env.DB, [
    userUpdate(user.id, { password_hash: await hashPassword(dto.newPassword), should_change_password: 0 }),
    readSessions,
    deleteSessions,
  ]);
  // stream H: close the realtime sockets of every deleted session (ids read in the same transaction as the delete)
  const deleted = (results[results.length - 2].results ?? []) as Array<{ id: string }>;
  c.executionCtx.waitUntil(disconnectSessions(c.env, user.id, deleted.map((s) => s.id)));
  return c.json(mapUserAdmin((await getUserAnyState(c.env.DB, user.id))!));
});

accountRoutes.post('/auth/pin-code', requireAuth, async (c) => {
  const { user } = c.get('auth');
  const dto = await readDto(c, 'PinCodeSetupDto');
  if (user.pin_code) throw new ImmichError(400, 'User already has a PIN code');
  await commit(c.env.DB, [userUpdate(user.id, { pin_code: await hashPassword(dto.pinCode) })]);
  return c.body(null, 204);
});

accountRoutes.put('/auth/pin-code', requireAuth, async (c) => {
  const { user } = c.get('auth');
  const dto = await readDto(c, 'PinCodeChangeDto');
  await validatePinCode(c.env.DB, user, dto);
  await commit(c.env.DB, [userUpdate(user.id, { pin_code: await hashPassword(dto.newPinCode) })]);
  return c.body(null, 204);
});

/** Removes the PIN and locks every session of the user. */
accountRoutes.delete('/auth/pin-code', requireAuth, async (c) => {
  const { user } = c.get('auth');
  const dto = await readDto(c, 'PinCodeResetDto');
  await validatePinCode(c.env.DB, user, dto);
  await commit(c.env.DB, [
    userUpdate(user.id, { pin_code: null }),
    c.env.DB.prepare('UPDATE sessions SET pin_expires_at = NULL WHERE user_id = ?1').bind(user.id),
  ]);
  return c.body(null, 204);
});

accountRoutes.post('/auth/session/unlock', requireAuth, async (c) => {
  const auth = c.get('auth');
  requireSessionToken(auth);
  const dto = await readDto(c, 'SessionUnlockDto');
  await validatePinCode(c.env.DB, auth.user, { pinCode: dto.pinCode });
  await c.env.DB.prepare('UPDATE sessions SET pin_expires_at = ?2 WHERE id = ?1')
    .bind(auth.session.id, new Date(Date.now() + UNLOCK_MS).toISOString())
    .run();
  return c.body(null, 204);
});

accountRoutes.post('/auth/session/lock', requireAuth, async (c) => {
  const auth = c.get('auth');
  requireSessionToken(auth);
  await c.env.DB.prepare('UPDATE sessions SET pin_expires_at = NULL WHERE id = ?1').bind(auth.session.id).run();
  return c.body(null, 204);
});

accountRoutes.get('/auth/status', requireAuth, (c) => {
  const { user, session, apiKey, hasElevatedPermission } = c.get('auth');
  return c.json({
    pinCode: !!user.pin_code,
    password: !!user.password_hash,
    isElevated: !!hasElevatedPermission,
    ...(!apiKey && session.expires_at ? { expiresAt: session.expires_at } : {}),
    ...(!apiKey && session.pin_expires_at ? { pinExpiresAt: session.pin_expires_at } : {}),
  });
});
