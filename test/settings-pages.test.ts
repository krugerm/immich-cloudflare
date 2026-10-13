import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { insertUser } from '../src/users/repo';
import { expectResponse } from './contract';
import { authHeaders, BASE, createUser, login, uploadAsset } from './helpers';

const get = (path: string, token?: string) => SELF.fetch(`${BASE}/api${path}`, { headers: token ? authHeaders(token) : {} });

async function setup() {
  const admin = await createUser();
  const other = await insertUser(env.DB, { email: 'bob@example.com', password: 'bob-pass-12', name: 'Bob', isAdmin: false });
  const adminToken = await login();
  const bobToken = await login('bob@example.com', 'bob-pass-12');
  return { admin, other, adminToken, bobToken };
}

const userRoutes = [
  ['/sessions', '/sessions'],
  ['/api-keys', '/api-keys'],
  ['/auth/status', '/auth/status'],
  ['/albums/statistics', '/albums/statistics'],
  ['/assets/statistics?visibility=timeline', '/assets/statistics'],
  ['/users/me/calendar-heatmap?from=2026-01-01&to=2026-01-10&type=Upload', '/users/me/calendar-heatmap'],
  ['/partners?direction=shared-by', '/partners'],
  ['/users', '/users'],
  ['/cluster-groups/requests', '/cluster-groups/requests'],
] as const;

describe('user settings page endpoints', () => {
  it.each(userRoutes)('GET %s matches the spec and requires auth', async (url, specPath) => {
    const { adminToken } = await setup();
    const res = await get(url, adminToken);
    expect(res.status).toBe(200);
    expectResponse(specPath, 'get', 200, await res.json());
    expect((await get(url)).status).toBe(401);
  });

  it('sessions lists only the caller sessions with exactly one current and no token hash', async () => {
    const { admin, adminToken, bobToken } = await setup();
    const secondAdminToken = await login();
    const mine = (await (await get('/sessions', adminToken)).json()) as Array<{ id: string; current: boolean }>;
    expect(mine).toHaveLength(2);
    expect(mine.filter((s) => s.current)).toHaveLength(1);
    const theirs = (await (await get('/sessions', bobToken)).json()) as Array<{ id: string; current: boolean }>;
    expect(theirs).toHaveLength(1);
    expect(theirs[0].current).toBe(true);
    expect(mine.map((s) => s.id)).not.toContain(theirs[0].id);
    const ownerOf = await env.DB.prepare('SELECT user_id FROM sessions WHERE id = ?1').bind(theirs[0].id).first<{ user_id: string }>();
    expect(ownerOf!.user_id).not.toBe(admin.id);
    expect(JSON.stringify(mine)).not.toMatch(/token|sha256/i);
    const other = (await (await get('/sessions', secondAdminToken)).json()) as Array<{ current: boolean }>;
    expect(other.filter((s) => s.current)).toHaveLength(1);
  });

  it('api-keys is empty and users lists accounts', async () => {
    const { adminToken } = await setup();
    expect(await (await get('/api-keys', adminToken)).json()).toEqual([]);
    const users = (await (await get('/users', adminToken)).json()) as Array<{ email: string }>;
    expect(users.map((u) => u.email).sort()).toEqual(['admin@example.com', 'bob@example.com']);
  });

  it('asset statistics count only the caller assets and heatmap counts uploads', async () => {
    const { adminToken, bobToken } = await setup();
    await uploadAsset(adminToken, new Uint8Array([1, 2, 3, 4]), { filename: 'a.jpg' });
    const mine = await (await get('/assets/statistics?visibility=timeline', adminToken)).json();
    expect(mine).toEqual({ images: 1, videos: 0, total: 1 });
    expect(await (await get('/assets/statistics', bobToken)).json()).toEqual({ images: 0, videos: 0, total: 0 });
    const today = new Date().toISOString().slice(0, 10);
    const heat = (await (await get(`/users/me/calendar-heatmap?from=${today}&to=${today}&type=Upload`, adminToken)).json()) as { totalCount: number };
    expect(heat.totalCount).toBe(1);
    expect((await get('/users/me/calendar-heatmap?from=bad&to=bad&type=Upload', adminToken)).status).toBe(400);
  });

  it('cluster group endpoints work for the own group only', async () => {
    const { admin, adminToken } = await setup();
    const res = await get(`/cluster-groups/${admin.id}/users`, adminToken);
    expect(res.status).toBe(200);
    expectResponse('/cluster-groups/{id}/users', 'get', 200, await res.json());
    const reqs = await get(`/cluster-groups/${admin.id}/requests`, adminToken);
    expectResponse('/cluster-groups/{id}/requests', 'get', 200, await reqs.json());
    expect((await get('/cluster-groups/00000000-0000-4000-8000-000000000000/users', adminToken)).status).toBe(403);
  });
});

const adminRoutes = [
  ['/system-config', '/system-config'],
  ['/system-config/defaults', '/system-config/defaults'],
  ['/system-config/storage-template-options', '/system-config/storage-template-options'],
  ['/admin/users?withDeleted=true', '/admin/users'],
  ['/server/statistics', '/server/statistics'],
  ['/queues', '/queues'],
  ['/queues/thumbnailGeneration', '/queues/{name}'],
  ['/queues/thumbnailGeneration/jobs?status=failed&status=paused', '/queues/{name}/jobs'],
  ['/jobs', '/jobs'],
  ['/libraries', '/libraries'],
  ['/admin/integrity/summary', '/admin/integrity/summary'],
  ['/admin/integrity/report?type=missing_file', '/admin/integrity/report'],
  ['/admin/database-backups', '/admin/database-backups'],
] as const;

describe('admin page endpoints', () => {
  it.each(adminRoutes)('GET %s matches the spec, 401 anonymous, 403 non-admin', async (url, specPath) => {
    const { adminToken, bobToken } = await setup();
    const res = await get(url, adminToken);
    expect(res.status).toBe(200);
    expectResponse(specPath, 'get', 200, await res.json());
    expect((await get(url)).status).toBe(401);
    expect((await get(url, bobToken)).status).toBe(403);
  });

  it('per-user admin endpoints match the spec and are admin only', async () => {
    const { other, adminToken, bobToken } = await setup();
    const cases = [
      [`/admin/users/${other.id}`, '/admin/users/{id}'],
      [`/admin/users/${other.id}/preferences`, '/admin/users/{id}/preferences'],
      [`/admin/users/${other.id}/statistics`, '/admin/users/{id}/statistics'],
      [`/admin/users/${other.id}/sessions`, '/admin/users/{id}/sessions'],
      [`/admin/users/${other.id}/calendar-heatmap?from=2026-01-01&to=2026-01-03&type=Upload`, '/admin/users/{id}/calendar-heatmap'],
    ];
    for (const [url, specPath] of cases) {
      const res = await get(url, adminToken);
      expect(res.status, url).toBe(200);
      expectResponse(specPath, 'get', 200, await res.json());
      expect((await get(url, bobToken)).status, url).toBe(403);
    }
    const sessions = (await (await get(`/admin/users/${other.id}/sessions`, adminToken)).json()) as Array<{ current: boolean }>;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].current).toBe(false);
  });

  it('admin users supports id filter and hides deleted users by default', async () => {
    const { other, adminToken } = await setup();
    const one = (await (await get(`/admin/users?id=${other.id}&withDeleted=true`, adminToken)).json()) as Array<{ id: string }>;
    expect(one.map((u) => u.id)).toEqual([other.id]);
    await env.DB.prepare('UPDATE users SET deleted_at = ?1 WHERE id = ?2').bind(new Date().toISOString(), other.id).run();
    expect(((await (await get('/admin/users', adminToken)).json()) as unknown[]).length).toBe(1);
    expect(((await (await get('/admin/users?withDeleted=true', adminToken)).json()) as unknown[]).length).toBe(2);
  });

  it('server statistics report real usage per user', async () => {
    const { admin, adminToken } = await setup();
    await uploadAsset(adminToken, new Uint8Array([9, 8, 7, 6, 5]), { filename: 'b.jpg' });
    const stats = (await (await get('/server/statistics', adminToken)).json()) as any;
    expect(stats.photos).toBe(1);
    expect(stats.usage).toBe(5);
    const row = stats.usageByUser.find((u: any) => u.userId === admin.id);
    expect(row.photos).toBe(1);
    expect(stats.usageByUser).toHaveLength(2);
  });

  it('library detail and unknown queue are errors', async () => {
    const { adminToken } = await setup();
    expect((await get('/libraries/00000000-0000-4000-8000-000000000000', adminToken)).status).toBe(404);
    expect((await get('/queues/bogus', adminToken)).status).toBe(400);
    expect((await get('/admin/users/00000000-0000-4000-8000-000000000000', adminToken)).status).toBe(400);
  });
});
