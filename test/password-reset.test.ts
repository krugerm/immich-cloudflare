import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settleResetWork } from '../src/auth/reset';
import { mailers, resendMailer, type ResetMailer } from '../src/auth/reset-mail';
import defaults from '../src/defaults/system-config.json';
import { insertUser } from '../src/users/repo';
import { BASE, createUser, login } from './helpers';
import { call, tok } from './stream-a-helpers';

const LINK = '<a href="/forgot-password">Forgot password?</a>';

type Sent = { to: string; link: string; name: string };
let sent: Sent[];

beforeEach(() => {
  sent = [];
  const fake: ResetMailer = {
    send: async (to, link, name) => {
      sent.push({ to, link, name });
    },
  };
  vi.spyOn(mailers, 'create').mockReturnValue(fake);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const randomIp = () => `10.${[0, 0, 0].map(() => Math.floor(Math.random() * 250)).join('.')}`;
// The rate limiter keeps its counters across tests, so every test uses its own email and client IP.
const uniqueEmail = () => `u${crypto.randomUUID().slice(0, 8)}@example.com`;

async function post(path: string, body: unknown, ip = randomIp()) {
  const res = await SELF.fetch(`${BASE}/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

async function requestReset(email: string, ip?: string) {
  const res = await post('/auth/password-reset/request', { email }, ip);
  await settleResetWork();
  return res;
}

const confirm = (token: string, password: string) => post('/auth/password-reset/confirm', { token, password });

async function newUser(password = 'old-pass-123') {
  const email = uniqueEmail();
  const user = await insertUser(env.DB, { email, password, name: 'Ann <Lee>', isAdmin: false });
  return { user, email, password };
}

const tokenOf = (link: string) => new URL(link).hash.replace(/^#token=/, '');

async function sha256Hex(s: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const resetRows = (userId: string) =>
  env.DB.prepare('SELECT * FROM password_resets WHERE user_id = ?1 ORDER BY created_at').bind(userId).all<Record<string, string | null>>().then((r) => r.results);

/** Moves the user's reset tokens `ms` into the past (created_at and expires_at), to step past the per-user windows. */
async function age(userId: string, ms: number) {
  for (const r of await resetRows(userId)) {
    await env.DB.prepare('UPDATE password_resets SET created_at = ?2, expires_at = ?3 WHERE token_hash = ?1')
      .bind(r.token_hash, new Date(Date.parse(r.created_at!) - ms).toISOString(), new Date(Date.parse(r.expires_at!) - ms).toISOString())
      .run();
  }
}

async function setConfig(change: (c: any) => void) {
  await createUser();
  const admin = await login();
  const config = structuredClone(defaults) as any;
  change(config);
  expect((await call('PUT', '/admin/config', tok(admin), config)).status).toBe(200);
  return admin;
}

describe('POST /auth/password-reset/request', () => {
  it('returns 204 and sends nothing for an unknown email', async () => {
    const res = await requestReset(uniqueEmail());
    expect(res.status).toBe(204);
    expect(sent).toEqual([]);
    expect((await env.DB.prepare('SELECT count(*) AS n FROM password_resets').first<number>('n'))).toBe(0);
  });

  it('rejects a malformed email with 400', async () => {
    expect((await post('/auth/password-reset/request', { email: 'not-an-email' })).status).toBe(400);
    expect((await post('/auth/password-reset/request', { email: 'a b@example.com' })).status).toBe(400);
    expect((await post('/auth/password-reset/request', {})).status).toBe(400);
    expect((await post('/auth/password-reset/request', { email: 5 })).status).toBe(400);
    expect(sent).toEqual([]);
  });

  it('sends one email whose link carries a token stored only as its SHA-256 hash', async () => {
    const { user, email } = await newUser();
    const res = await requestReset(email.toUpperCase());
    expect(res.status).toBe(204);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(email);
    expect(sent[0].name).toBe('Ann <Lee>');
    expect(sent[0].link).toMatch(/^https:\/\/immich\.test\/reset-password#token=[A-Za-z0-9_-]{43}$/);
    const token = tokenOf(sent[0].link);
    const rows = await resetRows(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toBe(await sha256Hex(token));
    expect(rows[0].used_at).toBeNull();
    const ttl = Date.parse(rows[0].expires_at!) - Date.parse(rows[0].created_at!);
    expect(ttl).toBe(30 * 60_000);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('builds the link from the configured external domain', async () => {
    await setConfig((c) => (c.server.externalDomain = 'https://photos.example.org'));
    await requestReset('admin@example.com');
    expect(sent).toHaveLength(1);
    expect(sent[0].link).toMatch(/^https:\/\/photos\.example\.org\/reset-password#token=/);
  });

  it('strips user:password credentials from the external domain', async () => {
    await setConfig((c) => (c.server.externalDomain = 'https://bob:hunter2@photos.example.org'));
    await requestReset('admin@example.com');
    expect(sent).toHaveLength(1);
    expect(sent[0].link).toMatch(/^https:\/\/photos\.example\.org\/reset-password#token=/);
    expect(sent[0].link).not.toContain('hunter2');
  });

  it('returns 400 when password login is disabled', async () => {
    await setConfig((c) => (c.passwordLogin.enabled = false));
    const res = await requestReset('admin@example.com');
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Password login is disabled');
    expect(sent).toEqual([]);
  });

  it('sends nothing for a soft-deleted user', async () => {
    const { user, email } = await newUser();
    await env.DB.prepare('UPDATE users SET deleted_at = ?2 WHERE id = ?1').bind(user.id, new Date().toISOString()).run();
    expect((await requestReset(email)).status).toBe(204);
    expect(sent).toEqual([]);
    expect(await resetRows(user.id)).toEqual([]);
  });

  it('sends nothing for a user without a password', async () => {
    const { user, email } = await newUser();
    await env.DB.prepare("UPDATE users SET password_hash = '' WHERE id = ?1").bind(user.id).run();
    expect((await requestReset(email)).status).toBe(204);
    expect(sent).toEqual([]);
  });

  it('keeps at most 3 usable tokens per user', async () => {
    const { user, email } = await newUser();
    for (let i = 0; i < 4; i++) {
      await requestReset(email);
      await age(user.id, 61_000); // past the 60 s per-user cooldown
    }
    expect(sent).toHaveLength(4);
    const now = new Date().toISOString();
    const usable = (await resetRows(user.id)).filter((r) => r.used_at === null && r.expires_at! > now);
    const hashes = await Promise.all(sent.map((s) => sha256Hex(tokenOf(s.link))));
    expect(usable.map((r) => r.token_hash).sort()).toEqual(hashes.slice(1).sort());
    expect((await confirm(tokenOf(sent[0].link), 'new-pass-123')).status).toBe(400);
  });

  it('sends nothing when the user got a token in the last 60 s', async () => {
    const { user, email } = await newUser();
    await requestReset(email);
    await age(user.id, 50_000);
    expect((await requestReset(email)).status).toBe(204);
    expect(sent).toHaveLength(1);
    expect(await resetRows(user.id)).toHaveLength(1);
    await age(user.id, 11_000);
    await requestReset(email);
    expect(sent).toHaveLength(2);
  });

  it('sends nothing when the user got 5 tokens in the last hour', async () => {
    const { user, email } = await newUser();
    // 7 requests for one email would trip the per-email RESET_LIMITER; this test is about the D1 window
    vi.spyOn(env.RESET_LIMITER, 'limit').mockResolvedValue({ success: true });
    for (let i = 0; i < 5; i++) {
      await requestReset(email);
      await age(user.id, 2 * 60_000);
    }
    expect(sent).toHaveLength(5); // the oldest was created 10 minutes ago
    expect((await requestReset(email)).status).toBe(204);
    expect(sent).toHaveLength(5);
    await age(user.id, 50 * 60_000 + 1000); // the oldest is now just over an hour old
    await requestReset(email);
    expect(sent).toHaveLength(6);
  });

  it('over the per-email limit: still 204, nothing sent', async () => {
    const { email } = await newUser();
    const limit = vi.spyOn(env.RESET_LIMITER, 'limit').mockImplementation(async ({ key }) => ({ success: !key.startsWith('email:') }));
    expect((await requestReset(email)).status).toBe(204);
    expect(sent).toEqual([]);
    expect(limit.mock.calls.map(([o]) => o.key)).toContain(`email:${email}`);
  });

  it('over the per-IP limit: still 204, nothing sent', async () => {
    const { email } = await newUser();
    const limit = vi.spyOn(env.RESET_LIMITER, 'limit').mockImplementation(async ({ key }) => ({ success: !key.startsWith('ip:') }));
    expect((await requestReset(email, '192.0.2.7')).status).toBe(204);
    expect(sent).toEqual([]);
    expect(limit.mock.calls.map(([o]) => o.key)).toContain('ip:192.0.2.7');
  });

  it('the real limiter stops sending after 5 requests from one IP', async () => {
    const ip = randomIp();
    for (let i = 0; i < 7; i++) expect((await requestReset((await newUser()).email, ip)).status).toBe(204);
    expect(sent).toHaveLength(5);
  });
});

describe('POST /auth/password-reset/confirm', () => {
  async function issued() {
    const u = await newUser();
    await env.DB.prepare('UPDATE users SET should_change_password = 1 WHERE id = ?1').bind(u.user.id).run();
    await requestReset(u.email);
    return { ...u, token: tokenOf(sent[sent.length - 1].link) };
  }

  it('sets the password, clears should_change_password, ends every session, keeps API keys and uses up the token', async () => {
    const { user, email, password, token } = await issued();
    await age(user.id, 61_000);
    await requestReset(email); // a second, still-valid token
    expect(await resetRows(user.id)).toHaveLength(2);
    const s1 = await login(email, password);
    const s2 = await login(email, password);
    const apiKey = await call('POST', '/api-keys', tok(s1), { name: 'script', permissions: ['all'] });
    expect(apiKey.status).toBe(201);
    expect((await call('GET', '/users/me', { 'x-api-key': apiKey.body.secret })).status).toBe(200);
    const before = await env.DB.prepare('SELECT update_id FROM users WHERE id = ?1').bind(user.id).first<string>('update_id');

    expect((await confirm(token, 'brand-new-pass')).status).toBe(204);

    expect((await call('GET', '/users/me', tok(s1))).status).toBe(401);
    expect((await call('GET', '/users/me', tok(s2))).status).toBe(401);
    // API keys survive a reset, as Immich keeps them on a password change.
    expect((await call('GET', '/users/me', { 'x-api-key': apiKey.body.secret })).status).toBe(200);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM sessions WHERE user_id = ?1').bind(user.id).first<number>('n')).toBe(0);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM api_keys WHERE user_id = ?1').bind(user.id).first<number>('n')).toBe(1);
    await expect(login(email, password)).rejects.toThrow();
    const fresh = await login(email, 'brand-new-pass');
    expect((await call('GET', '/users/me', tok(fresh))).body.shouldChangePassword).toBe(false);
    const row = await env.DB.prepare('SELECT should_change_password, update_id FROM users WHERE id = ?1').bind(user.id).first<any>();
    expect(row.should_change_password).toBe(0);
    expect(row.update_id > before!).toBe(true); // tracked, so sync sees the change

    const rows = await resetRows(user.id);
    expect(rows).toHaveLength(1); // the other token is gone
    expect(rows[0].token_hash).toBe(await sha256Hex(token));
    expect(rows[0].used_at).not.toBeNull();
    const again = await confirm(token, 'another-pass-1');
    expect(again.status).toBe(400);
    expect(again.body.message).toBe('Invalid or expired link');
  });

  it('rejects a wrong, malformed or missing token', async () => {
    await issued();
    for (const token of ['A'.repeat(43), 'short', 42, undefined]) {
      const res = await post('/auth/password-reset/confirm', { token, password: 'brand-new-pass' });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Invalid or expired link');
    }
  });

  it('rejects an expired token', async () => {
    const { user, token, email, password } = await issued();
    await env.DB.prepare('UPDATE password_resets SET expires_at = ?2 WHERE user_id = ?1').bind(user.id, new Date(Date.now() - 1000).toISOString()).run();
    const res = await confirm(token, 'brand-new-pass');
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Invalid or expired link');
    await login(email, password);
  });

  it('rejects a token of a user deleted after it was issued', async () => {
    const { user, token } = await issued();
    await env.DB.prepare('UPDATE users SET deleted_at = ?2 WHERE id = ?1').bind(user.id, new Date().toISOString()).run();
    expect((await confirm(token, 'brand-new-pass')).status).toBe(400);
  });

  it('validates the new password like change-password and keeps the token usable', async () => {
    const { token, email } = await issued();
    expect((await confirm(token, 'short')).status).toBe(400);
    expect((await post('/auth/password-reset/confirm', { token })).status).toBe(400);
    expect((await confirm(token, 'long-enough-1')).status).toBe(204);
    await login(email, 'long-enough-1');
  });

  it('two concurrent confirms with the same token: exactly one succeeds', async () => {
    const { token, email } = await issued();
    const results = await Promise.all([confirm(token, 'first-pass-123'), confirm(token, 'second-pass-123')]);
    expect(results.map((r) => r.status).sort()).toEqual([204, 400]);
    const loser = results.find((r) => r.status === 400)!;
    expect(loser.body.message).toBe('Invalid or expired link');
    const winner = results[0].status === 204 ? 'first-pass-123' : 'second-pass-123';
    await login(email, winner);
  });

  it('rejects a token of a user that is being removed', async () => {
    const { user, token } = await issued();
    await env.DB.prepare("UPDATE users SET status = 'removing' WHERE id = ?1").bind(user.id).run();
    expect((await confirm(token, 'brand-new-pass')).status).toBe(400);
  });

  it('returns 400 when password login is disabled', async () => {
    const { token } = await issued();
    const admin = await setConfig((c) => (c.passwordLogin.enabled = false));
    expect(admin).toBeTruthy();
    const res = await confirm(token, 'brand-new-pass');
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Password login is disabled');
  });
});

describe('reset pages', () => {
  const csp = (scriptHash: string) =>
    `default-src 'none'; style-src 'unsafe-inline'; script-src '${scriptHash}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;

  async function scriptHash(html: string) {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts).toHaveLength(1);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(scripts[0])));
    return `sha256-${btoa(String.fromCharCode(...digest))}`;
  }

  for (const [path, api] of [
    ['/forgot-password', '/api/auth/password-reset/request'],
    ['/reset-password', '/api/auth/password-reset/confirm'],
  ]) {
    it(`GET ${path} serves a self-contained page with strict headers`, async () => {
      const res = await SELF.fetch(`${BASE}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^text\/html; charset=utf-8/i);
      const html = await res.text();
      expect(res.headers.get('content-security-policy')).toBe(csp(await scriptHash(html)));
      expect(html).not.toMatch(/\son[a-z]+=/i); // no inline event handlers (the hash covers the script element only)
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(html).toContain('<title>Immich</title>');
      expect(html).toContain('name="viewport"');
      expect(html).toContain('prefers-color-scheme: dark');
      expect(html).toContain(api);
      expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=/);
    });
  }

  it('the reset page reads the token from the fragment', async () => {
    const html = await (await SELF.fetch(`${BASE}/reset-password`)).text();
    expect(html).toContain('location.hash');
    expect(html).toContain('/forgot-password');
    expect(html).toContain('This signs you out everywhere.');
    expect(html).not.toContain('API key');
  });
});

describe('resendMailer', () => {
  const LINK_URL = 'https://p.example/reset-password#token=abc';
  const MAIL_ENV = { RESEND_API_KEY: 're_test_key', MAIL_FROM: 'Immich <photos@example.com>' };

  it('posts the message to the Resend API with the bearer key', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: 'e1' }), { status: 200 }));
    await resendMailer(MAIL_ENV).send('ann@example.com', LINK_URL, 'Ann <Lee>');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer re_test_key');
    expect(headers.get('content-type')).toBe('application/json');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const m = JSON.parse(init.body as string);
    expect(m.from).toBe('Immich <photos@example.com>');
    expect(m.to).toEqual(['ann@example.com']);
    expect(m.subject).toBe('Reset your password');
    for (const body of [m.text, m.html]) {
      expect(body).toContain(LINK_URL);
      expect(body).toContain('30 minutes');
      expect(body).toContain("If you didn't ask for this, ignore this email.");
      expect(body).toContain('This signs you out everywhere.');
      expect(body).not.toContain('API key');
    }
    expect(m.text).toContain('Ann <Lee>');
    expect(m.html).toContain('Ann &lt;Lee&gt;');
    expect(m.html).not.toContain('<Lee>');
    for (const body of [m.text, m.html]) expect(body).toContain('your Immich account');
  });

  it('names the product from APP_NAME in the text and HTML', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: 'e1' }), { status: 200 }));
    await resendMailer({ ...MAIL_ENV, APP_NAME: 'Family & Friends' }).send('ann@example.com', LINK_URL, 'Ann');
    const m = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(m.text).toContain('your Family & Friends account');
    expect(m.html).toContain('your Family &amp; Friends account');
    expect(m.text).not.toContain('Immich');
  });

  it('falls back to "Immich" when APP_NAME is empty', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: 'e1' }), { status: 200 }));
    await resendMailer({ ...MAIL_ENV, APP_NAME: '' }).send('ann@example.com', LINK_URL, 'Ann');
    const m = JSON.parse((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(m.text).toContain('your Immich account');
  });

  it('logs and sends nothing without RESEND_API_KEY', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await resendMailer({ MAIL_FROM: MAIL_ENV.MAIL_FROM }).send('ann@example.com', LINK_URL, 'Ann');
    expect(log).toHaveBeenCalledWith('password reset email not configured');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('logs and sends nothing without MAIL_FROM', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await resendMailer({ RESEND_API_KEY: 're_test_key' }).send('ann@example.com', LINK_URL, 'Ann');
    expect(log).toHaveBeenCalledWith('password reset email not configured');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('logs a non-2xx response without the key or link and does not throw', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ statusCode: 422, name: 'validation_error', message: 'bad' }), { status: 422 }),
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await resendMailer(MAIL_ENV).send('ann@example.com', LINK_URL, 'Ann');
    expect(error).toHaveBeenCalledWith('password reset email failed', 422, 'validation_error');
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).not.toContain('re_test_key');
    expect(logged).not.toContain('token=');
  });

  it('logs a network error and does not throw', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await resendMailer(MAIL_ENV).send('ann@example.com', LINK_URL, 'Ann');
    expect(error).toHaveBeenCalledWith('password reset email failed', 'TypeError');
  });

  it('a failing Resend call still leaves the request endpoint at 204', async () => {
    const { email } = await newUser();
    vi.spyOn(mailers, 'create').mockReturnValue(resendMailer(MAIL_ENV));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"name":"internal_server_error"}', { status: 500 }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await requestReset(email)).status).toBe(204);
    expect(fetchSpy.mock.calls.some(([u]) => String(u) === 'https://api.resend.com/emails')).toBe(true);
  });
});

describe('login page link', () => {
  it('GET /server/config shows only the link when no admin message is set', async () => {
    const res = await call('GET', '/server/config');
    expect(res.status).toBe(200);
    expect(res.body.loginPageMessage).toBe(LINK);
  });

  it('appends the link to the admin message; the admin config keeps the text unchanged', async () => {
    await createUser();
    const admin = await login();
    const config = structuredClone(defaults) as any;
    config.server.loginPageMessage = 'Welcome to the family archive';
    expect((await call('PUT', '/admin/config', tok(admin), config)).status).toBe(200);

    expect((await call('GET', '/server/config')).body.loginPageMessage).toBe(`Welcome to the family archive<br>${LINK}`);
    expect((await call('GET', '/admin/config', tok(admin))).body.server.loginPageMessage).toBe('Welcome to the family archive');
    // The web login page reads /public/config, so the link is appended there as well.
    expect((await call('GET', '/public/config')).body.server.loginPageMessage).toBe(
      'Welcome to the family archive<br><a href="/forgot-password">Forgot password?</a>',
    );
    expect((await call('GET', '/public/config/defaults')).body.server.loginPageMessage).toBe('');
  });

  // The Immich mobile apps (immich-android/<ver>, immich-ios/<ver>) never display loginPageMessage; they get the
  // admin text without the HTML link.
  for (const ua of ['immich-android/2.1.0', 'immich-ios/2.1.0']) {
    it(`omits the link for the mobile app (${ua})`, async () => {
      const res = await SELF.fetch(`${BASE}/api/server/config`, { headers: { 'user-agent': ua } });
      expect(((await res.json()) as any).loginPageMessage).toBe('');
    });
  }

  it('keeps the link for a browser user agent', async () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
    const res = await SELF.fetch(`${BASE}/api/server/config`, { headers: { 'user-agent': ua } });
    expect(((await res.json()) as any).loginPageMessage).toBe(LINK);
  });

  it('leaves the message alone when password login is disabled', async () => {
    await createUser();
    const admin = await login();
    const config = structuredClone(defaults) as any;
    config.server.loginPageMessage = 'OAuth only';
    config.passwordLogin.enabled = false;
    expect((await call('PUT', '/admin/config', tok(admin), config)).status).toBe(200);
    expect((await call('GET', '/server/config')).body.loginPageMessage).toBe('OAuth only');
  });
});
