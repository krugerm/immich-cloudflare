import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/auth/session';
import { expectResponse } from './contract';
import { call, key, tok, twoUsers } from './stream-a-helpers';

async function createKey(token: string, permissions: string[] = ['all'], name?: string) {
  const res = await call('POST', '/api-keys', tok(token), { name, permissions });
  expect(res.status).toBe(201);
  expectResponse('/api-keys', 'post', 201, res.body);
  return res.body as { id: string; secret: string; name: string; permissions: string[] };
}

describe('API keys', () => {
  it('creates a key, returns the secret once and stores only its SHA-256', async () => {
    const { adminToken } = await twoUsers();
    const k = await createKey(adminToken, ['all'], 'cli');
    expect(k.name).toBe('cli');
    expect(k.secret.length).toBeGreaterThan(30);
    const row = await env.DB.prepare('SELECT * FROM api_keys WHERE id = ?1').bind(k.id).first<Record<string, string>>();
    expect(row!.key_sha256).toBe(await sha256Hex(k.secret));
    expect(JSON.stringify(row)).not.toContain(k.secret);

    const list = await call('GET', '/api-keys', tok(adminToken));
    expectResponse('/api-keys', 'get', 200, list.body);
    expect(list.body).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(k.secret);
    const one = await call('GET', `/api-keys/${k.id}`, tok(adminToken));
    expectResponse('/api-keys/{id}', 'get', 200, one.body);
    expect(one.body.name).toBe('cli');
  });

  it('defaults the name and validates input', async () => {
    const { adminToken } = await twoUsers();
    expect((await createKey(adminToken)).name).toBe('API Key');
    expect((await call('POST', '/api-keys', tok(adminToken), { permissions: [] })).status).toBe(400);
    expect((await call('POST', '/api-keys', tok(adminToken), { permissions: ['nope'] })).status).toBe(400);
    expect((await call('POST', '/api-keys', tok(adminToken), { name: 'x' })).status).toBe(400);
    expect((await call('POST', '/api-keys', tok(adminToken), '{bad')).status).toBe(400);
    expect((await call('GET', '/api-keys/not-a-uuid', tok(adminToken))).status).toBe(400);
  });

  it('authenticates with x-api-key and ?apiKey=, and rejects unknown keys', async () => {
    const { admin, adminToken } = await twoUsers();
    const k = await createKey(adminToken);
    const me = await call('GET', '/users/me', key(k.secret));
    expect(me.status).toBe(200);
    expect(me.body.id).toBe(admin.id);
    expect((await call('GET', `/users/me?apiKey=${encodeURIComponent(k.secret)}`)).status).toBe(200);
    const bad = await call('GET', '/users/me', key('wrong'));
    expect(bad.status).toBe(401);
    expect(bad.body.message).toBe('Invalid API key');
    // A session token wins and is not retried as a key.
    expect((await call('GET', '/users/me', { ...tok('bogus'), ...key(k.secret) })).status).toBe(401);
  });

  it('enforces the permissions of the key per route', async () => {
    const { adminToken } = await twoUsers();
    const k = await createKey(adminToken, ['user.read', 'apiKey.read']);
    expect((await call('GET', '/users/me', key(k.secret))).status).toBe(200);
    expect((await call('GET', '/api-keys', key(k.secret))).status).toBe(200);
    const denied = await call('PUT', '/users/me', key(k.secret), { name: 'x' });
    expect(denied.status).toBe(403);
    expect(denied.body.message).toBe('Missing required permission: user.update');
    // Routes without an x-immich-permission need `all`; validateToken and api-keys/me need nothing.
    expect((await call('GET', '/auth/status', key(k.secret))).status).toBe(403);
    expect((await call('POST', '/auth/validateToken', key(k.secret))).status).toBe(200);
    const mine = await call('GET', '/api-keys/me', key(k.secret));
    expect(mine.status).toBe(200);
    expectResponse('/api-keys/me', 'get', 200, mine.body);
    expect(mine.body.id).toBe(k.id);
  });

  it('GET /api-keys/me is 403 for a session', async () => {
    const { adminToken } = await twoUsers();
    expect((await call('GET', '/api-keys/me', tok(adminToken))).status).toBe(403);
  });

  it('admin routes still require an admin user behind the key', async () => {
    const { adminToken, bobToken } = await twoUsers();
    const adminKey = await createKey(adminToken);
    const bobKey = await createKey(bobToken);
    expect((await call('GET', '/admin/users', key(adminKey.secret))).status).toBe(200);
    expect((await call('GET', '/admin/users', key(bobKey.secret))).status).toBe(403);
  });

  it('rejects sync endpoints with 403', async () => {
    const { adminToken } = await twoUsers();
    const k = await createKey(adminToken);
    for (const [method, path, body] of [
      ['POST', '/sync/stream', { types: ['AuthUsersV2'] }],
      ['GET', '/sync/ack', undefined],
      ['POST', '/sync/ack', { acks: [] }],
      ['DELETE', '/sync/ack', {}],
    ] as const) {
      const res = await call(method, path, key(k.secret), body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.body.message).toBe('Sync endpoints cannot be used with API keys');
    }
  });

  it('a key cannot grant permissions it lacks', async () => {
    const { adminToken } = await twoUsers();
    const k = await createKey(adminToken, ['apiKey.create', 'apiKey.update', 'apiKey.rotate', 'apiKey.read']);
    expect((await call('POST', '/api-keys', key(k.secret), { permissions: ['all'] })).status).toBe(400);
    expect((await call('POST', '/api-keys', key(k.secret), { permissions: ['apiKey.read'] })).status).toBe(201);
    const full = await createKey(adminToken, ['all']);
    expect((await call('PUT', `/api-keys/${full.id}`, key(k.secret), { permissions: ['all'] })).status).toBe(400);
    expect((await call('POST', `/api-keys/${full.id}/rotate`, key(k.secret))).status).toBe(400);
  });

  it('updates, rotates and deletes', async () => {
    const { adminToken } = await twoUsers();
    const k = await createKey(adminToken);
    const upd = await call('PUT', `/api-keys/${k.id}`, tok(adminToken), { name: 'renamed', permissions: ['asset.read'] });
    expect(upd.status).toBe(200);
    expectResponse('/api-keys/{id}', 'put', 200, upd.body);
    expect(upd.body).toMatchObject({ name: 'renamed', permissions: ['asset.read'] });

    const rot = await call('POST', `/api-keys/${k.id}/rotate`, tok(adminToken));
    expect(rot.status).toBe(201);
    expectResponse('/api-keys/{id}/rotate', 'post', 201, rot.body);
    expect(rot.body.secret).not.toBe(k.secret);
    expect((await call('GET', '/api-keys/me', key(k.secret))).status).toBe(401);
    expect((await call('GET', '/api-keys/me', key(rot.body.secret))).status).toBe(200);

    expect((await call('DELETE', `/api-keys/${k.id}`, tok(adminToken))).status).toBe(204);
    expect((await call('GET', '/api-keys/me', key(rot.body.secret))).status).toBe(401);
    expect((await call('DELETE', `/api-keys/${k.id}`, tok(adminToken))).status).toBe(400);
  });

  it("other users' keys are not visible or changeable", async () => {
    const { adminToken, bobToken } = await twoUsers();
    const k = await createKey(adminToken);
    expect((await call('GET', '/api-keys', tok(bobToken))).body).toEqual([]);
    expect((await call('GET', `/api-keys/${k.id}`, tok(bobToken))).status).toBe(400);
    expect((await call('PUT', `/api-keys/${k.id}`, tok(bobToken), { name: 'x' })).status).toBe(400);
    expect((await call('POST', `/api-keys/${k.id}/rotate`, tok(bobToken))).status).toBe(400);
    expect((await call('DELETE', `/api-keys/${k.id}`, tok(bobToken))).status).toBe(400);
  });

  it('keys of a deleted user stop working; endpoints require auth', async () => {
    const { adminToken, bob, bobToken } = await twoUsers();
    const k = await createKey(bobToken);
    expect((await call('DELETE', `/admin/users/${bob.id}`, tok(adminToken), {})).status).toBe(200);
    expect((await call('GET', '/users/me', key(k.secret))).status).toBe(401);
    expect((await call('GET', '/api-keys')).status).toBe(401);
  });
});
