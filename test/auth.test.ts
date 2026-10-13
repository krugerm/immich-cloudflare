import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/password';
import { extractToken, sha256Hex } from '../src/auth/session';
import { expectResponse } from './contract';
import { authHeaders, BASE, createUser, login } from './helpers';

describe('password', () => {
  it('hashes in the versioned format and verifies', async () => {
    const h = await hashPassword('pw-123456');
    expect(h).toMatch(/^pbkdf2-sha256\$100000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(await verifyPassword('pw-123456', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
  });
});

describe('extractToken', () => {
  const req = (headers: Record<string, string>, query = '') => new Request(`${BASE}/api/x${query}`, { headers });
  it('follows Immich order', () => {
    expect(extractToken(req({ 'x-immich-user-token': 'a', authorization: 'Bearer b' }))).toBe('a');
    expect(extractToken(req({ 'x-immich-session-token': 's', cookie: 'immich_access_token=c' }))).toBe('s');
    expect(extractToken(req({ authorization: 'Bearer b', cookie: 'immich_access_token=c' }, '?sessionKey=k'))).toBe('k');
    expect(extractToken(req({ authorization: 'Bearer b', cookie: 'immich_access_token=c' }))).toBe('b');
    expect(extractToken(req({ cookie: 'x=1; immich_access_token=c; y=2' }))).toBe('c');
    expect(extractToken(req({}))).toBeNull();
  });
});

describe('auth routes', () => {
  it('admin sign-up works once, then refuses', async () => {
    const body = JSON.stringify({ email: 'first@example.com', password: 'pw-123456', name: 'First' });
    const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body };
    const res = await SELF.fetch(`${BASE}/api/auth/admin-sign-up`, init);
    expect(res.status).toBe(201);
    const user = await res.json();
    expectResponse('/auth/admin-sign-up', 'post', 201, user);
    expect((user as { isAdmin: boolean }).isAdmin).toBe(true);
    const again = await SELF.fetch(`${BASE}/api/auth/admin-sign-up`, init);
    expect(again.status).toBe(400);
  });

  it('login returns the DTO and sets the three cookies', async () => {
    await createUser();
    const res = await SELF.fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-immich-device-model': 'iPhone', 'cf-connecting-ip': '203.0.113.1' },
      body: JSON.stringify({ email: 'ADMIN@example.com', password: 'secret-pass-1' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expectResponse('/auth/login', 'post', 201, body);
    expect(body.isOnboarded).toBe(true);
    const cookies = res.headers.getSetCookie();
    expect(cookies.find((c) => c.startsWith('immich_access_token='))).toMatch(/HttpOnly/);
    expect(cookies.find((c) => c.startsWith('immich_auth_type=password'))).toMatch(/HttpOnly/);
    const isAuth = cookies.find((c) => c.startsWith('immich_is_authenticated=true'))!;
    expect(isAuth).not.toMatch(/HttpOnly/);
    for (const c of cookies) expect(c).toMatch(/Path=\/.*SameSite=Lax|SameSite=Lax.*Path=\//);
  });

  it('rejects a wrong password with 401', async () => {
    await createUser();
    const res = await SELF.fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.2' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'nope' }),
    });
    expect(res.status).toBe(401);
  });

  it('rate-limits repeated login attempts', async () => {
    await createUser();
    let last = 0;
    for (let i = 0; i < 12; i++) {
      const res = await SELF.fetch(`${BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.3' },
        body: JSON.stringify({ email: 'admin@example.com', password: 'nope' }),
      });
      last = res.status;
    }
    expect(last).toBe(429);
  });

  it('validateToken accepts the token from a cookie and rejects garbage', async () => {
    await createUser();
    const token = await login();
    const ok = await SELF.fetch(`${BASE}/api/auth/validateToken`, { method: 'POST', headers: { cookie: `immich_access_token=${token}` } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ authStatus: true });
    const bad = await SELF.fetch(`${BASE}/api/auth/validateToken`, { method: 'POST', headers: authHeaders('garbage') });
    expect(bad.status).toBe(401);
  });

  it('logout deletes the session and clears cookies', async () => {
    await createUser();
    const token = await login();
    const res = await SELF.fetch(`${BASE}/api/auth/logout`, { method: 'POST', headers: authHeaders(token) });
    expect(res.status).toBe(200);
    expectResponse('/auth/logout', 'post', 200, await res.json());
    expect(res.headers.getSetCookie().some((c) => c.startsWith('immich_access_token=;'))).toBe(true);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM sessions').first('n')).toBe(0);
  });

  const post = (path: string, body: BodyInit, ip: string, headers: Record<string, string> = {}) =>
    SELF.fetch(`${BASE}/api/auth/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip, ...headers },
      body,
    });

  it('answers an unknown email exactly like a wrong password', async () => {
    await createUser({ email: 'known@example.com' });
    const wrong = await post('login', JSON.stringify({ email: 'known@example.com', password: 'nope' }), '203.0.113.10');
    const unknown = await post('login', JSON.stringify({ email: 'nobody@example.com', password: 'nope' }), '203.0.113.11');
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toMatchObject({ message: ((await wrong.json()) as { message: string }).message });
  });

  const fail = (email: string, i: number) =>
    post('login', JSON.stringify({ email, password: 'nope' }), `198.51.100.${i + 1}`);
  const good = (email: string, ip: string) => post('login', JSON.stringify({ email, password: 'secret-pass-1' }), ip);

  it('locks an account after 10 failures from different IPs, even for the correct password', async () => {
    await createUser({ email: 'victim@example.com' });
    for (let i = 0; i < 10; i++) expect((await fail('victim@example.com', i)).status).toBe(401);
    expect((await good('victim@example.com', '198.51.100.200')).status).toBe(429);
  });

  it('lets the account in again once the failure window has expired', async () => {
    await createUser({ email: 'expired@example.com' });
    for (let i = 0; i < 10; i++) await fail('expired@example.com', i);
    const old = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    await env.DB.prepare('UPDATE login_failures SET window_start = ?1').bind(old).run();
    expect((await good('expired@example.com', '198.51.100.201')).status).toBe(201);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM login_failures').first('n')).toBe(0);
  });

  it('clears the failure counter on a successful login', async () => {
    await createUser({ email: 'clears@example.com' });
    for (let i = 0; i < 3; i++) await fail('clears@example.com', i);
    expect(await env.DB.prepare('SELECT failures AS f FROM login_failures').first('f')).toBe(3);
    expect((await good('clears@example.com', '198.51.100.202')).status).toBe(201);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM login_failures').first('n')).toBe(0);
  });

  it('lets only one of two concurrent admin sign-ups succeed', async () => {
    const mk = (email: string) => post('admin-sign-up', JSON.stringify({ email, password: 'pw-123456', name: 'A' }), '203.0.113.20');
    const results = await Promise.all([mk('a@example.com'), mk('b@example.com')]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 400]);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM users').first('n')).toBe(1);
    expect(await env.DB.prepare('SELECT storage_label AS s FROM users').first('s')).toBe('admin');
  });

  it('returns 400 for malformed bodies', async () => {
    expect((await post('login', '{not json', '203.0.113.30')).status).toBe(400);
    expect((await post('login', JSON.stringify({ email: 5, password: 'x' }), '203.0.113.31')).status).toBe(400);
    expect((await post('admin-sign-up', JSON.stringify({ email: 'noat', password: 'pw', name: 'A' }), '203.0.113.32')).status).toBe(400);
    expect((await post('admin-sign-up', '[]', '203.0.113.33')).status).toBe(400);
  });

  it('treats an undecodable cookie as absent', async () => {
    const res = await SELF.fetch(`${BASE}/api/auth/validateToken`, { method: 'POST', headers: { cookie: 'immich_access_token=%zz' } });
    expect(res.status).toBe(401);
  });

  it('falls through empty token headers to a valid Bearer token', async () => {
    await createUser();
    const token = await login();
    const res = await SELF.fetch(`${BASE}/api/auth/validateToken`, {
      method: 'POST',
      headers: { 'x-immich-user-token': '', authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });

  it('stores only the SHA-256 of the token', async () => {
    await createUser();
    const token = await login();
    const stored = await env.DB.prepare('SELECT token_sha256 AS t FROM sessions').first<string>('t');
    expect(stored).not.toBe(token);
    expect(stored).toBe(await sha256Hex(token));
  });
});
