import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import defaults from '../src/defaults/system-config.json';
import { insertUser } from '../src/users/repo';
import { expectResponse, expectSchema } from './contract';
import { authHeaders, BASE, createUser, login } from './helpers';

const call = (method: string, path: string, token?: string, body?: unknown) =>
  SELF.fetch(`${BASE}/api${path}`, {
    method,
    headers: { ...(token ? authHeaders(token) : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });

async function setup() {
  await createUser();
  await insertUser(env.DB, { email: 'bob@example.com', password: 'bob-pass-12', name: 'Bob', isAdmin: false });
  return { adminToken: await login(), bobToken: await login('bob@example.com', 'bob-pass-12') };
}

const withChanges = () => {
  const c = structuredClone(defaults) as any;
  c.server.loginPageMessage = 'Welcome to the family archive';
  c.trash.days = 14;
  c.theme.customCss = 'body { color: red; }';
  c.user.deleteDelay = 3;
  c.oauth.buttonText = 'Sign in';
  return c;
};

describe('system config', () => {
  it('PUT /admin/config stores the config; every reader returns it', async () => {
    const { adminToken, bobToken } = await setup();
    const res = await call('PUT', '/admin/config', adminToken, withChanges());
    expect(res.status).toBe(200);
    const saved = (await res.json()) as any;
    expectResponse('/admin/config', 'put', 200, saved);
    expect(saved.server.loginPageMessage).toBe('Welcome to the family archive');

    const admin = (await (await call('GET', '/admin/config', adminToken)).json()) as any;
    expectResponse('/admin/config', 'get', 200, admin);
    expect(admin).toEqual(saved);
    const legacy = (await (await call('GET', '/system-config', adminToken)).json()) as any;
    expect(legacy).toEqual(saved);

    const user = (await (await call('GET', '/config', bobToken)).json()) as any;
    expectResponse('/config', 'get', 200, user);
    expect(user.trash).toEqual({ days: 14, enabled: true });
    expect(user.notifications).toBeUndefined(); // admin-only sections are not visible to users
    expect(user.oauth.clientSecret).toBeUndefined();

    const server = (await (await call('GET', '/server/config')).json()) as any;
    expectResponse('/server/config', 'get', 200, server);
    // the self-service reset link is appended (test/password-reset.test.ts)
    expect(server.loginPageMessage).toBe('Welcome to the family archive<br><a href="/forgot-password">Forgot password?</a>');
    expect(server).toMatchObject({ trashDays: 14, userDeleteDelay: 3, oauthButtonText: 'Sign in' });

    const pub = (await (await call('GET', '/public/config')).json()) as any;
    expectResponse('/public/config', 'get', 200, pub);
    expect(pub).toEqual({
      oauth: { autoLaunch: false, buttonText: 'Sign in', enabled: false },
      passwordLogin: { enabled: true },
      // the web login page reads this endpoint, so it carries the reset link too
      server: { loginPageMessage: 'Welcome to the family archive<br><a href="/forgot-password">Forgot password?</a>' },
      theme: { customCss: 'body { color: red; }' },
    });
  });

  it('deprecated PUT /system-config writes the same config; only the diff is stored', async () => {
    const { adminToken } = await setup();
    const res = await call('PUT', '/system-config', adminToken, withChanges());
    expect(res.status).toBe(200);
    expectResponse('/system-config', 'put', 200, await res.json());
    const stored = JSON.parse((await env.DB.prepare('SELECT value FROM system_config').first<string>('value'))!);
    expect(stored).toEqual({
      server: { loginPageMessage: 'Welcome to the family archive' },
      trash: { days: 14 },
      theme: { customCss: 'body { color: red; }' },
      user: { deleteDelay: 3 },
      oauth: { buttonText: 'Sign in' },
    });
    // writing the defaults back clears the diff
    await call('PUT', '/system-config', adminToken, defaults);
    expect(await env.DB.prepare('SELECT value FROM system_config').first<string>('value')).toBe('{}');
  });

  it('defaults endpoints return the captured defaults whatever is stored', async () => {
    const { adminToken, bobToken } = await setup();
    await call('PUT', '/admin/config', adminToken, withChanges());
    const d = await (await call('GET', '/admin/config/defaults', adminToken)).json();
    expectResponse('/admin/config/defaults', 'get', 200, d);
    expect(d).toEqual(defaults);
    expect(await (await call('GET', '/system-config/defaults', adminToken)).json()).toEqual(defaults);
    const ud = (await (await call('GET', '/config/defaults', bobToken)).json()) as any;
    expectResponse('/config/defaults', 'get', 200, ud);
    expect(ud.server.loginPageMessage).toBe('');
    expect((await (await call('GET', '/public/config/defaults')).json()) as any).toMatchObject({ server: { loginPageMessage: '' } });
  });

  it('unknown keys are dropped', async () => {
    const { adminToken } = await setup();
    const c = withChanges();
    c.extra = { nope: 1 };
    c.server.bogus = true;
    const saved = (await (await call('PUT', '/admin/config', adminToken, c)).json()) as any;
    expect(saved.extra).toBeUndefined();
    expect(saved.server.bogus).toBeUndefined();
  });

  it('rejects invalid configs with 400 and stores nothing', async () => {
    const { adminToken } = await setup();
    const bad = [
      (c: any) => delete c.trash,
      (c: any) => (c.trash.days = 'x'),
      (c: any) => (c.trash.days = 1.5),
      (c: any) => (c.ffmpeg.crf = 99),
      (c: any) => (c.logging.level = 'loud'),
      (c: any) => (c.nightlyTasks.startTime = '25:00'),
      (c: any) => (c.machineLearning.urls = []),
      (c: any) => (c.map.darkStyle = 'not a url'),
      (c: any) => (c.server.externalDomain = 'not a url'),
      (c: any) => (c.server = null),
    ];
    for (const mutate of bad) {
      const c = structuredClone(defaults);
      mutate(c);
      const res = await call('PUT', '/admin/config', adminToken, c);
      expect(res.status, JSON.stringify(c).slice(0, 80)).toBe(400);
    }
    expect((await call('PUT', '/admin/config', adminToken, '[1]')).status).toBe(400);
    expect((await call('PUT', '/admin/config', adminToken, 'not json')).status).toBe(400);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM system_config').first('n')).toBe(0);
  });

  it('enabling SMTP fails verification as Immich does when SMTP is unreachable', async () => {
    const { adminToken } = await setup();
    const c = structuredClone(defaults) as any;
    c.notifications.smtp.enabled = true;
    c.notifications.smtp.transport.host = 'smtp.example.com';
    const res = await call('PUT', '/admin/config', adminToken, c);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toBe('Invalid SMTP configuration');
  });

  it('externalDomain is normalised to its origin', async () => {
    const { adminToken } = await setup();
    const c = structuredClone(defaults) as any;
    c.server.externalDomain = 'https://photos.example.com/some/path';
    const saved = (await (await call('PUT', '/admin/config', adminToken, c)).json()) as any;
    expect(saved.server.externalDomain).toBe('https://photos.example.com');
  });

  it('admin endpoints are admin only; user config needs a login', async () => {
    const { bobToken } = await setup();
    for (const [method, path] of [['GET', '/admin/config'], ['GET', '/admin/config/defaults'], ['PUT', '/admin/config'], ['PUT', '/system-config']] as const) {
      expect((await call(method, path, bobToken, method === 'PUT' ? defaults : undefined)).status).toBe(403);
      expect((await call(method, path, undefined, method === 'PUT' ? defaults : undefined)).status).toBe(401);
    }
    expect((await call('GET', '/config')).status).toBe(401);
    expect((await call('GET', '/config/defaults')).status).toBe(401);
  });

  it('the captured defaults satisfy AdminConfigDto', () => {
    expectSchema('AdminConfigDto', defaults);
  });
});
