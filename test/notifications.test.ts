import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import defaults from '../src/defaults/system-config.json';
import { insertUser } from '../src/users/repo';
import { expectResponse } from './contract';
import { authHeaders, BASE, createUser, login } from './helpers';

const call = (method: string, path: string, token?: string, body?: unknown) =>
  SELF.fetch(`${BASE}/api${path}`, {
    method,
    headers: { ...(token ? authHeaders(token) : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function setup() {
  const admin = await createUser();
  const bob = await insertUser(env.DB, { email: 'bob@example.com', password: 'bob-pass-12', name: 'Bob', isAdmin: false });
  return { admin, bob, adminToken: await login(), bobToken: await login('bob@example.com', 'bob-pass-12') };
}

async function notify(adminToken: string, userId: string, extra: Record<string, unknown> = {}) {
  const res = await call('POST', '/admin/notifications', adminToken, { userId, title: 'Hello', ...extra });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string };
  expectResponse('/admin/notifications', 'post', 201, body);
  return body;
}

describe('notifications', () => {
  it('admin creates; the user lists, filters, reads, marks read and deletes', async () => {
    const { bob, adminToken, bobToken } = await setup();
    const n1 = await notify(adminToken, bob.id, { description: 'first', data: { k: 1 }, level: 'warning', type: 'SystemMessage' });
    const n2 = await notify(adminToken, bob.id);
    expect(n1).toMatchObject({ title: 'Hello', description: 'first', data: { k: 1 }, level: 'warning', type: 'SystemMessage' });
    expect(n2).toMatchObject({ level: 'info', type: 'Custom' });
    expect('readAt' in n2).toBe(false);

    const list = (await (await call('GET', '/notifications', bobToken)).json()) as Array<{ id: string }>;
    expectResponse('/notifications', 'get', 200, list);
    expect(list.map((n) => n.id).sort()).toEqual([n1.id, n2.id].sort());
    expect(await (await call('GET', '/notifications', adminToken)).json()).toEqual([]);
    expect(((await (await call('GET', '/notifications?level=warning', bobToken)).json()) as unknown[]).length).toBe(1);
    expect(((await (await call('GET', '/notifications?type=Custom', bobToken)).json()) as unknown[]).length).toBe(1);
    expect(((await (await call('GET', `/notifications?id=${n1.id}`, bobToken)).json()) as unknown[]).length).toBe(1);

    const one = await call('GET', `/notifications/${n1.id}`, bobToken);
    expect(one.status).toBe(200);
    expectResponse('/notifications/{id}', 'get', 200, await one.json());

    const upd = await call('PUT', `/notifications/${n1.id}`, bobToken, { readAt: '2026-10-12T10:00:00.000Z' });
    expect(upd.status).toBe(200);
    const updated = (await upd.json()) as { readAt?: string };
    expectResponse('/notifications/{id}', 'put', 200, updated);
    expect(updated.readAt).toBe('2026-10-12T10:00:00.000Z');
    expect(((await (await call('GET', '/notifications?unread=true', bobToken)).json()) as Array<{ id: string }>).map((n) => n.id)).toEqual([n2.id]);

    expect((await call('PUT', '/notifications', bobToken, { ids: [n1.id, n2.id], readAt: null })).status).toBe(204);
    expect(((await (await call('GET', '/notifications?unread=true', bobToken)).json()) as unknown[]).length).toBe(2);

    expect((await call('DELETE', `/notifications/${n1.id}`, bobToken)).status).toBe(204);
    const deletedAt = await env.DB.prepare('SELECT deleted_at FROM notifications WHERE id = ?1').bind(n1.id).first<string>('deleted_at');
    await new Promise((r) => setTimeout(r, 5));
    expect((await call('DELETE', `/notifications/${n1.id}`, bobToken)).status).toBe(204);
    expect((await call('DELETE', '/notifications', bobToken, { ids: [n1.id] })).status).toBe(204);
    expect(await env.DB.prepare('SELECT deleted_at FROM notifications WHERE id = ?1').bind(n1.id).first<string>('deleted_at')).toBe(deletedAt);
    expect((await call('DELETE', '/notifications', bobToken, { ids: [n2.id] })).status).toBe(204);
    expect(await (await call('GET', '/notifications', bobToken)).json()).toEqual([]);
    expect((await call('GET', `/notifications/${n1.id}`, bobToken)).status).toBe(400);
    expect((await call('PUT', `/notifications/${n1.id}`, bobToken, { readAt: null })).status).toBe(400);
  });

  it('other users get 400 for notifications they do not own', async () => {
    const { bob, adminToken } = await setup();
    const n = await notify(adminToken, bob.id);
    for (const [method, path, body] of [
      ['GET', `/notifications/${n.id}`, undefined],
      ['PUT', `/notifications/${n.id}`, { readAt: null }],
      ['DELETE', `/notifications/${n.id}`, undefined],
      ['PUT', '/notifications', { ids: [n.id], readAt: null }],
      ['DELETE', '/notifications', { ids: [n.id] }],
    ] as const) {
      const res = await call(method, path, adminToken, body);
      expect(res.status, `${method} ${path}`).toBe(400);
      expect(((await res.json()) as { message: string }).message).toMatch(/^Not found or no notification\.(read|update|delete) access$/);
    }
  });

  it('validates input', async () => {
    const { bob, adminToken, bobToken } = await setup();
    const n = await notify(adminToken, bob.id);
    expect((await call('GET', '/notifications?level=loud', bobToken)).status).toBe(400);
    expect((await call('GET', '/notifications?type=Nope', bobToken)).status).toBe(400);
    expect((await call('GET', '/notifications?id=x', bobToken)).status).toBe(400);
    expect((await call('GET', '/notifications?unread=maybe', bobToken)).status).toBe(400);
    expect((await call('GET', '/notifications/not-a-uuid', bobToken)).status).toBe(400);
    expect((await call('PUT', `/notifications/${n.id}`, bobToken, { readAt: 'yesterday' })).status).toBe(400);
    expect((await call('PUT', '/notifications', bobToken, { ids: [] })).status).toBe(400);
    expect((await call('PUT', '/notifications', bobToken, { ids: ['x'] })).status).toBe(400);
    expect((await call('DELETE', '/notifications', bobToken, {})).status).toBe(400);
    expect((await call('POST', '/admin/notifications', adminToken, { userId: bob.id })).status).toBe(400);
    expect((await call('POST', '/admin/notifications', adminToken, { userId: bob.id, title: 'x', level: 'loud' })).status).toBe(400);
    const missing = await call('POST', '/admin/notifications', adminToken, { userId: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d', title: 'x' });
    expect(missing.status).toBe(400);
    expect((await call('GET', '/notifications')).status).toBe(401);
  });

  it('admin endpoints are admin only', async () => {
    const { bob, bobToken } = await setup();
    expect((await call('POST', '/admin/notifications', bobToken, { userId: bob.id, title: 'x' })).status).toBe(403);
    expect((await call('POST', '/admin/notifications/templates/welcome', bobToken, { template: '' })).status).toBe(403);
    expect((await call('POST', '/admin/notifications/test-email', bobToken, defaults.notifications.smtp)).status).toBe(403);
  });

  it('templates render the custom template with Immich tags; unknown names are empty', async () => {
    const { adminToken } = await setup();
    const res = await call('POST', '/admin/notifications/templates/welcome', adminToken, { template: 'Hi {displayName} <b>{username}</b> {unknown}' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; html: string };
    expectResponse('/admin/notifications/templates/{name}', 'post', 200, body);
    expect(body.name).toBe('welcome');
    expect(body.html).toContain('Hi John Doe &#60;b&#62;john@doe.com&#60;/b&#62; {unknown}');
    const fallback = (await (await call('POST', '/admin/notifications/templates/album-invite', adminToken, { template: '' })).json()) as { html: string };
    expect(fallback.html).toContain('Jane Doe');
    expect(await (await call('POST', '/admin/notifications/templates/other', adminToken, { template: 'x' })).json()).toEqual({ name: 'other', html: '' });
    expect((await call('POST', '/admin/notifications/templates/welcome', adminToken, {})).status).toBe(400);
  });

  it('test-email validates the SMTP config, then fails verification (no email in phase 2)', async () => {
    const { adminToken } = await setup();
    const res = await call('POST', '/admin/notifications/test-email', adminToken, defaults.notifications.smtp);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toBe('Failed to verify SMTP configuration');
    const bad = await call('POST', '/admin/notifications/test-email', adminToken, { enabled: true });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { message: string }).message).not.toBe('Failed to verify SMTP configuration');
  });
});
