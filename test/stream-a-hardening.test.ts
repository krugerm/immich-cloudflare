import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { PIN_MAX_FAILURES } from '../src/auth/account';
import { findSession } from '../src/auth/session';
import { purgeDeletedUsers, purgeExpiredSessions } from '../src/cron/purge-users';
import { BASE, login } from './helpers';
import { call, tok, twoUsers } from './stream-a-helpers';

const MB = 1024 * 1024;

/** A multipart body streamed in 1 MB chunks with no Content-Length; counts how many bytes the server pulled. */
function chunkedProfileBody(fileBytes: number) {
  const enc = new TextEncoder();
  const head = enc.encode('--XB\r\nContent-Disposition: form-data; name="file"; filename="big.jpg"\r\nContent-Type: image/jpeg\r\n\r\n');
  const tail = enc.encode('\r\n--XB--\r\n');
  let sent = 0;
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (pulled === 0) {
        pulled += head.byteLength;
        c.enqueue(head);
        c.enqueue(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]));
        return;
      }
      if (sent < fileBytes) {
        const n = Math.min(MB, fileBytes - sent);
        sent += n;
        pulled += n;
        c.enqueue(new Uint8Array(n));
        return;
      }
      c.enqueue(tail);
      c.close();
    },
  });
  return { body, pulled: () => pulled };
}

describe('profile image upload limits', () => {
  it('stops reading a chunked body without Content-Length once it passes 10 MB', async () => {
    const { adminToken } = await twoUsers();
    const big = chunkedProfileBody(40 * MB);
    const res = await SELF.fetch(`${BASE}/api/users/profile-image`, {
      method: 'POST',
      headers: { ...tok(adminToken), 'content-type': 'multipart/form-data; boundary=XB' },
      body: big.body,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toBe('Profile image is too large');
    expect(big.pulled()).toBeLessThan(20 * MB);
  });

  it('rejects a declared Content-Length over the cap before reading', async () => {
    const { adminToken } = await twoUsers();
    const res = await SELF.fetch(`${BASE}/api/users/profile-image`, {
      method: 'POST',
      headers: { ...tok(adminToken), 'content-type': 'multipart/form-data; boundary=XB', 'content-length': String(11 * MB) },
      body: 'x',
    });
    expect(res.status).toBe(400);
  });

  it('serves the image with nosniff and no shared caching', async () => {
    const { admin, adminToken } = await twoUsers();
    const form = new FormData();
    form.append('file', new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], 'p.jpg'));
    expect((await SELF.fetch(`${BASE}/api/users/profile-image`, { method: 'POST', headers: tok(adminToken), body: form })).status).toBe(201);
    const img = await SELF.fetch(`${BASE}/api/users/${admin.id}/profile-image`, { headers: tok(adminToken) });
    expect(img.headers.get('x-content-type-options')).toBe('nosniff');
    expect(img.headers.get('cache-control')).toBe('private, no-cache, no-transform');
    await img.arrayBuffer();
  });
});

describe('PIN lockout', () => {
  it(`locks PIN checks after ${PIN_MAX_FAILURES} failures, even for the right PIN`, async () => {
    const { adminToken } = await twoUsers();
    await call('POST', '/auth/pin-code', tok(adminToken), { pinCode: '123456' });
    for (let i = 0; i < PIN_MAX_FAILURES; i++) {
      expect((await call('POST', '/auth/session/unlock', tok(adminToken), { pinCode: '000000' })).status).toBe(400);
    }
    const locked = await call('POST', '/auth/session/unlock', tok(adminToken), { pinCode: '123456' });
    expect(locked.status).toBe(429);
    expect((await call('PUT', '/auth/pin-code', tok(adminToken), { pinCode: '123456', newPinCode: '222222' })).status).toBe(429);
    expect((await call('DELETE', '/auth/pin-code', tok(adminToken), { password: 'secret-pass-1' })).status).toBe(429);
  });

  it('a success resets the counter; the lock is per user', async () => {
    const { adminToken, bobToken } = await twoUsers();
    await call('POST', '/auth/pin-code', tok(adminToken), { pinCode: '123456' });
    await call('POST', '/auth/pin-code', tok(bobToken), { pinCode: '654321' });
    for (let i = 0; i < PIN_MAX_FAILURES - 1; i++) await call('POST', '/auth/session/unlock', tok(adminToken), { pinCode: '000000' });
    expect((await call('POST', '/auth/session/unlock', tok(adminToken), { pinCode: '123456' })).status).toBe(204);
    expect((await call('POST', '/auth/session/unlock', tok(adminToken), { pinCode: '000000' })).status).toBe(400);
    expect((await call('POST', '/auth/session/unlock', tok(adminToken), { pinCode: '123456' })).status).toBe(204);
    for (let i = 0; i < PIN_MAX_FAILURES; i++) await call('POST', '/auth/session/unlock', tok(adminToken), { pinCode: '000000' });
    expect((await call('POST', '/auth/session/unlock', tok(bobToken), { pinCode: '654321' })).status).toBe(204);
  });
});

describe('sessions and purge', () => {
  it('a duration past the largest date is 400', async () => {
    const { adminToken } = await twoUsers();
    expect((await call('POST', '/sessions', tok(adminToken), { duration: 9007199254740991 })).status).toBe(400);
  });

  it('the daily cleanup deletes expired sessions only', async () => {
    const { adminToken } = await twoUsers();
    const child = (await call('POST', '/sessions', tok(adminToken), { duration: 60 })).body;
    expect(await purgeExpiredSessions(env)).toBe(0);
    expect(await purgeExpiredSessions(env, new Date(Date.now() + 120_000))).toBe(1);
    expect(await env.DB.prepare('SELECT 1 FROM sessions WHERE id = ?1').bind(child.id).first()).toBeNull();
    expect((await findSession(env.DB, adminToken))).not.toBeNull();
  });

  it('a user that cannot be purged does not block the others', async () => {
    const { bob, adminToken } = await twoUsers();
    await call('POST', '/admin/users', tok(adminToken), { email: 'c@example.com', name: 'C', password: 'c-pass-123' });
    const carol = (await env.DB.prepare(`SELECT id FROM users WHERE email = 'c@example.com'`).first<string>('id'))!;
    await env.DB.exec('CREATE TABLE blocker (user_id TEXT REFERENCES users (id))');
    try {
      await env.DB.prepare('INSERT INTO blocker (user_id) VALUES (?1)').bind(bob.id).run();
      await call('DELETE', `/admin/users/${bob.id}`, tok(adminToken), { force: true });
      await call('DELETE', `/admin/users/${carol}`, tok(adminToken), { force: true });
      expect(await purgeDeletedUsers(env)).toBe(1);
      expect(await env.DB.prepare('SELECT 1 FROM users WHERE id = ?1').bind(carol).first()).toBeNull();
      expect(await env.DB.prepare('SELECT 1 FROM users WHERE id = ?1').bind(bob.id).first()).not.toBeNull();
    } finally {
      await env.DB.exec('DROP TABLE blocker');
    }
    expect(await login()).toBeTruthy();
  });
});

const loginAttempt = (email: string, password: string, i: number) =>
  SELF.fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': `192.0.2.${i + 1}` },
    body: JSON.stringify({ email, password }),
  });

describe('lockout keys and atomic reservation', () => {
  it('login attempts with email `pin:<id>` never touch the PIN lock', async () => {
    const { admin, adminToken } = await twoUsers();
    await call('POST', '/auth/pin-code', tok(adminToken), { pinCode: '123456' });
    for (let i = 0; i < 12; i++) {
      const res = await loginAttempt(`pin:${admin.id}`, 'x', i);
      expect(res.status).toBe(400);
      await res.arrayBuffer();
    }
    // Even an email-shaped variant lands in the login: namespace.
    for (let i = 0; i < 12; i++) await (await loginAttempt(`pin:${admin.id}@x.y`, 'x', i)).arrayBuffer();
    const keys = (await env.DB.prepare('SELECT email FROM login_failures').all<{ email: string }>()).results.map((r) => r.email);
    expect(keys).toEqual([`login:pin:${admin.id}@x.y`]);
    expect((await call('POST', '/auth/session/unlock', tok(adminToken), { pinCode: '123456' })).status).toBe(204);
  });

  it('login rejects an email without @ before counting', async () => {
    await twoUsers();
    const res = await loginAttempt('admin', 'x', 1);
    expect(res.status).toBe(400);
    await res.arrayBuffer();
    expect(await env.DB.prepare('SELECT count(*) AS n FROM login_failures').first<number>('n')).toBe(0);
  });

  it(`concurrent wrong PINs: at most ${PIN_MAX_FAILURES} are verified, the rest get 429`, async () => {
    const { adminToken } = await twoUsers();
    await call('POST', '/auth/pin-code', tok(adminToken), { pinCode: '123456' });
    const n = PIN_MAX_FAILURES * 3;
    const results = await Promise.all(Array.from({ length: n }, () => call('POST', '/auth/session/unlock', tok(adminToken), { pinCode: '000000' })));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 400).length).toBe(PIN_MAX_FAILURES);
    expect(statuses.filter((s) => s === 429).length).toBe(n - PIN_MAX_FAILURES);
  });

  it('concurrent wrong logins: at most 10 are verified, the rest get 429', async () => {
    await twoUsers();
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => loginAttempt('bob@example.com', 'wrong', i)));
    const statuses = results.map((r) => r.status);
    await Promise.all(results.map((r) => r.arrayBuffer()));
    expect(statuses.filter((s) => s === 401).length).toBe(10);
    expect(statuses.filter((s) => s === 429).length).toBe(15);
  });
});
