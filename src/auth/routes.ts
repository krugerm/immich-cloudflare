import { type Context, Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from '../app';
import { ImmichError } from '../http/errors';
import { mapUserAdmin } from '../users/map';
import { getUserByEmail, insertFirstAdmin } from '../users/repo';
import { clearAttempts, loginKey, reserveAttempt } from './lockout';
import { hashPassword, verifyPassword } from './password';
import { createSession, requireAuth } from './session';
import { disconnectSessions } from '../realtime/emit'; // stream H
import { deleteSessionTree } from '../sessions/routes';

const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

const MAX_AGE = 400 * 24 * 60 * 60;
const base = { path: '/', sameSite: 'Lax', secure: true, maxAge: MAX_AGE } as const;

// Verified against when the email is unknown, so both failure paths cost one PBKDF2 run.
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= hashPassword(crypto.randomUUID()));

async function readBody(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ImmichError(400, 'Invalid JSON body');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ImmichError(400, 'Invalid request body');
  return body as Record<string, unknown>;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

export const authRoutes = new Hono<AppEnv>();

authRoutes.post('/auth/admin-sign-up', async (c) => {
  const body = await readBody(c);
  const email = str(body.email);
  const password = str(body.password);
  const name = str(body.name);
  if (!email || !password || !name) throw new ImmichError(400, 'email, password and name are required');
  if (!email.includes('@')) throw new ImmichError(400, 'email must be a valid email address');
  const user = await insertFirstAdmin(c.env.DB, { email, password, name });
  if (!user) throw new ImmichError(400, 'The server already has an admin');
  return c.json(mapUserAdmin(user), 201);
});

authRoutes.post('/auth/login', async (c) => {
  const body = await readBody(c);
  const email = str(body.email);
  const password = str(body.password);
  if (!email || !password) throw new ImmichError(400, 'email and password are required');
  if (!email.includes('@')) throw new ImmichError(400, 'email must be a valid email address');
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  const lower = email.toLowerCase();
  const perIp = await c.env.LOGIN_LIMITER.limit({ key: `${lower}|${ip}` });
  if (!perIp.success) throw new ImmichError(429, 'Too many login attempts');
  // stream A: the attempt is counted before verifying (atomic reserve), and cleared on success.
  const key = loginKey(lower);
  if (!(await reserveAttempt(c.env.DB, key, MAX_FAILURES, FAILURE_WINDOW_MS))) throw new ImmichError(429, 'Too many login attempts');
  const user = await getUserByEmail(c.env.DB, email);
  const valid = await verifyPassword(password, user?.password_hash ?? (await getDummyHash()));
  if (!user || !valid) throw new ImmichError(401, 'Incorrect email or password');
  await clearAttempts(c.env.DB, key);
  const { token } = await createSession(
    c.env.DB,
    user.id,
    c.req.header('x-immich-device-type') ?? c.req.header('devicetype') ?? '',
    c.req.header('x-immich-device-model') ?? c.req.header('devicemodel') ?? '',
  );
  setCookie(c, 'immich_access_token', token, { ...base, httpOnly: true });
  setCookie(c, 'immich_auth_type', 'password', { ...base, httpOnly: true });
  setCookie(c, 'immich_is_authenticated', 'true', { ...base, httpOnly: false });
  return c.json(
    {
      accessToken: token,
      userId: user.id,
      userEmail: user.email,
      name: user.name,
      isAdmin: user.is_admin === 1,
      isOnboarded: user.is_onboarded === 1,
      profileImagePath: user.profile_image_path,
      shouldChangePassword: user.should_change_password === 1,
    },
    201,
  );
});

authRoutes.post('/auth/validateToken', requireAuth, (c) => c.json({ authStatus: true }));

authRoutes.post('/auth/logout', requireAuth, async (c) => {
  const { user, session } = c.get('auth');
  // The session and its child sessions (cascade); their sockets close after the delete (stream H)
  c.executionCtx.waitUntil(disconnectSessions(c.env, user.id, await deleteSessionTree(c.env.DB, user.id, session.id)));
  for (const name of ['immich_access_token', 'immich_auth_type', 'immich_is_authenticated']) {
    deleteCookie(c, name, { path: '/', secure: true });
  }
  return c.json({ successful: true, redirectUri: '/auth/login?autoLaunch=0' });
});
