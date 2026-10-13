import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { commit, tracked } from '../src/db/changes';
import { partnerCanReadAsset } from '../src/access/partners';
import { Hono } from 'hono';
import type { AppEnv } from '../src/app';
import type { AuthContext } from '../src/auth/session';
import { onError } from '../src/http/errors';
import { loadOwnAsset } from '../src/media/routes';
import { insertUser } from '../src/users/repo';
import { expectResponse } from './contract';
import { authHeaders, BASE, createUser, login, uploadAsset } from './helpers';

const call = (method: string, path: string, token?: string, body?: unknown) =>
  SELF.fetch(`${BASE}/api${path}`, {
    method,
    headers: { ...(token ? authHeaders(token) : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

async function setup() {
  const admin = await createUser();
  const bob = await insertUser(env.DB, { email: 'bob@example.com', password: 'bob-pass-12', name: 'Bob', isAdmin: false });
  const carol = await insertUser(env.DB, { email: 'carol@example.com', password: 'carol-pass-1', name: 'Carol', isAdmin: false });
  const adminToken = await login();
  const bobToken = await login('bob@example.com', 'bob-pass-12');
  const carolToken = await login('carol@example.com', 'carol-pass-1');
  return { admin, bob, carol, adminToken, bobToken, carolToken };
}

describe('partner endpoints', () => {
  it('create, list both directions, update inTimeline, remove', async () => {
    const { admin, bob, adminToken, bobToken } = await setup();
    const created = await call('POST', '/partners', adminToken, { sharedWithId: bob.id });
    expect(created.status).toBe(201);
    const body = (await created.json()) as Record<string, unknown>;
    expectResponse('/partners', 'post', 201, body);
    expect(body).toMatchObject({ id: bob.id, email: 'bob@example.com', inTimeline: false });

    const sharedBy = await (await call('GET', '/partners?direction=shared-by', adminToken)).json();
    expectResponse('/partners', 'get', 200, sharedBy);
    expect((sharedBy as Array<{ id: string }>).map((p) => p.id)).toEqual([bob.id]);
    expect(await (await call('GET', '/partners?direction=shared-with', adminToken)).json()).toEqual([]);
    const sharedWith = (await (await call('GET', '/partners?direction=shared-with', bobToken)).json()) as Array<{ id: string }>;
    expect(sharedWith.map((p) => p.id)).toEqual([admin.id]);

    const updated = await call('PUT', `/partners/${admin.id}`, bobToken, { inTimeline: true });
    expect(updated.status).toBe(200);
    const u = (await updated.json()) as Record<string, unknown>;
    expectResponse('/partners/{id}', 'put', 200, u);
    expect(u).toMatchObject({ id: admin.id, inTimeline: true });

    expect((await call('DELETE', `/partners/${bob.id}`, adminToken)).status).toBe(204);
    expect(await (await call('GET', '/partners?direction=shared-with', bobToken)).json()).toEqual([]);
    const audit = await env.DB.prepare('SELECT shared_by_id, shared_with_id FROM partner_audit').all();
    expect(audit.results).toEqual([{ shared_by_id: admin.id, shared_with_id: bob.id }]);
  });

  it('deprecated POST /partners/{id} creates a partner', async () => {
    const { bob, adminToken } = await setup();
    const res = await call('POST', `/partners/${bob.id}`, adminToken);
    expect(res.status).toBe(201);
    expectResponse('/partners/{id}', 'post', 201, await res.json());
  });

  it('rejects duplicates, unknown users, self, bad input and missing auth', async () => {
    const { admin, bob, adminToken } = await setup();
    await call('POST', '/partners', adminToken, { sharedWithId: bob.id });
    const dup = await call('POST', '/partners', adminToken, { sharedWithId: bob.id });
    expect(dup.status).toBe(400);
    expect(((await dup.json()) as { message: string }).message).toBe('Partner already exists');
    const missing = await call('POST', '/partners', adminToken, { sharedWithId: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d' });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { message: string }).message).toBe('Invalid user');
    expect((await call('POST', '/partners', adminToken, { sharedWithId: admin.id })).status).toBe(400);
    expect((await call('POST', '/partners', adminToken, { sharedWithId: 'nope' })).status).toBe(400);
    expect((await call('POST', '/partners', adminToken, {})).status).toBe(400);
    expect((await call('POST', '/partners/not-a-uuid', adminToken)).status).toBe(400);
    expect((await call('GET', '/partners', adminToken)).status).toBe(400);
    expect((await call('GET', '/partners?direction=sideways', adminToken)).status).toBe(400);
    expect((await call('GET', '/partners?direction=shared-by')).status).toBe(401);
  });

  it('only the shared-with side may update; remove needs an existing partner', async () => {
    const { admin, bob, adminToken, bobToken, carolToken } = await setup();
    await call('POST', '/partners', adminToken, { sharedWithId: bob.id });
    // the sharer cannot toggle the partner's timeline, nor can a stranger
    const own = await call('PUT', `/partners/${bob.id}`, adminToken, { inTimeline: true });
    expect(own.status).toBe(400);
    expect(((await own.json()) as { message: string }).message).toBe('Not found or no partner.update access');
    expect((await call('PUT', `/partners/${admin.id}`, carolToken, { inTimeline: true })).status).toBe(400);
    expect((await call('PUT', `/partners/${admin.id}`, bobToken, { inTimeline: 'yes' })).status).toBe(400);
    expect((await call('PUT', `/partners/${admin.id}`, bobToken, {})).status).toBe(400);
    // bob cannot remove a partnership he did not create
    const rm = await call('DELETE', `/partners/${admin.id}`, bobToken);
    expect(rm.status).toBe(400);
    expect(((await rm.json()) as { message: string }).message).toBe('Partner not found');
  });

  it('hides partners whose user is deleted', async () => {
    const { bob, adminToken } = await setup();
    await call('POST', '/partners', adminToken, { sharedWithId: bob.id });
    await commit(env.DB, [tracked("UPDATE users SET deleted_at = '2026-01-01T00:00:00.000Z', update_id = :cursor WHERE id = ?1", bob.id)]);
    expect(await (await call('GET', '/partners?direction=shared-by', adminToken)).json()).toEqual([]);
  });
});

describe('partner asset access', () => {
  it('a partner can read the sharer assets; others cannot', async () => {
    const { admin, bob, adminToken, bobToken, carolToken } = await setup();
    const a = await uploadAsset(adminToken, crypto.getRandomValues(new Uint8Array(100)));
    expect((await call('GET', `/assets/${a.body.id}`, bobToken)).status).toBe(404);
    await call('POST', '/partners', adminToken, { sharedWithId: bob.id });
    const res = await call('GET', `/assets/${a.body.id}`, bobToken);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ownerId: string }).ownerId).toBe(admin.id);
    expect((await call('GET', `/assets/${a.body.id}`, carolToken)).status).toBe(404);
    expect(await partnerCanReadAsset(env.DB, bob.id, a.body.id)).toBe(true);
    expect(await partnerCanReadAsset(env.DB, admin.id, a.body.id)).toBe(false); // owners are not partners of themselves
  });

  it('GET /assets/{id} hides the owner favourite from partners', async () => {
    const { bob, adminToken, bobToken } = await setup();
    const a = await uploadAsset(adminToken, crypto.getRandomValues(new Uint8Array(100)));
    await commit(env.DB, [tracked('UPDATE assets SET is_favorite = 1, update_id = :cursor WHERE id = ?1', a.body.id)]);
    await call('POST', '/partners', adminToken, { sharedWithId: bob.id });
    const asPartner = (await (await call('GET', `/assets/${a.body.id}`, bobToken)).json()) as { isFavorite: boolean };
    expectResponse('/assets/{id}', 'get', 200, asPartner);
    expect(asPartner.isFavorite).toBe(false);
    expect(((await (await call('GET', `/assets/${a.body.id}`, adminToken)).json()) as { isFavorite: boolean }).isFavorite).toBe(true);
  });

  it('loadOwnAsset admits the owner only', async () => {
    const { bob, adminToken } = await setup();
    const a = await uploadAsset(adminToken, crypto.getRandomValues(new Uint8Array(100)));
    await call('POST', '/partners', adminToken, { sharedWithId: bob.id });
    const app = new Hono<AppEnv>();
    app.onError(onError);
    app.get('/t/:id', async (c) => {
      c.set('auth', { user: { id: c.req.header('x-user')! } } as AuthContext);
      return c.json((await loadOwnAsset(c, c.req.param('id'))).id);
    });
    const as = (userId: string) => app.request(`/t/${a.body.id}`, { headers: { 'x-user': userId } }, env);
    expect((await as(bob.id)).status).toBe(404);
    expect(await (await as((await env.DB.prepare('SELECT owner_id FROM assets').first<string>('owner_id'))!)).json()).toBe(a.body.id);
  });

  it('archived, locked and trashed assets are not partner-readable', async () => {
    const { bob, adminToken } = await setup();
    await call('POST', '/partners', adminToken, { sharedWithId: bob.id });
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await uploadAsset(adminToken, crypto.getRandomValues(new Uint8Array(40 + i)))).body.id);
    await commit(env.DB, [
      tracked("UPDATE assets SET visibility = 'archive', update_id = :cursor WHERE id = ?1", ids[0]),
      tracked("UPDATE assets SET visibility = 'locked', update_id = :cursor WHERE id = ?1", ids[1]),
      tracked("UPDATE assets SET deleted_at = '2026-01-01T00:00:00.000Z', update_id = :cursor WHERE id = ?1", ids[2]),
      tracked("UPDATE assets SET visibility = 'hidden', update_id = :cursor WHERE id = ?1", ids[3]),
    ]);
    expect(await Promise.all(ids.map((id) => partnerCanReadAsset(env.DB, bob.id, id)))).toEqual([false, false, false, true]);
  });
});

describe('partner timeline', () => {
  async function shared() {
    const s = await setup();
    await uploadAsset(s.adminToken, crypto.getRandomValues(new Uint8Array(100)), { filename: 'admin.jpg' });
    await uploadAsset(s.bobToken, crypto.getRandomValues(new Uint8Array(101)), { filename: 'bob.jpg' });
    await call('POST', '/partners', s.adminToken, { sharedWithId: s.bob.id });
    return s;
  }
  const total = async (token: string, query: string) => {
    const res = await call('GET', `/timeline/buckets?${query}`, token);
    expect(res.status).toBe(200);
    return ((await res.json()) as Array<{ count: number }>).reduce((n, b) => n + b.count, 0);
  };

  it('withPartners includes partners with inTimeline only', async () => {
    const { admin, bobToken } = await shared();
    expect(await total(bobToken, 'visibility=timeline&withPartners=true')).toBe(1);
    await call('PUT', `/partners/${admin.id}`, bobToken, { inTimeline: true });
    expect(await total(bobToken, 'visibility=timeline&withPartners=true')).toBe(2);
    expect(await total(bobToken, 'visibility=timeline')).toBe(1);
    const buckets = (await (await call('GET', '/timeline/buckets?visibility=timeline&withPartners=true', bobToken)).json()) as Array<{ timeBucket: string }>;
    const bucket = await call('GET', `/timeline/bucket?visibility=timeline&withPartners=true&timeBucket=${buckets[0].timeBucket}`, bobToken);
    const body = (await bucket.json()) as { ownerId: string[] };
    expectResponse('/timeline/bucket', 'get', 200, body);
    expect(body.ownerId).toContain(admin.id);
  });

  it('withPartners is refused for archive, favorite, trash or missing visibility', async () => {
    const { bobToken } = await shared();
    for (const q of ['withPartners=true', 'visibility=archive&withPartners=true', 'visibility=timeline&withPartners=true&isFavorite=true', 'visibility=timeline&withPartners=true&isTrashed=true']) {
      expect((await call('GET', `/timeline/buckets?${q}`, bobToken)).status).toBe(400);
    }
  });

  it('userId reads a partner timeline and is refused for non-partners', async () => {
    const { admin, bob, bobToken, carolToken, adminToken } = await shared();
    expect(await total(bobToken, `userId=${admin.id}&visibility=timeline`)).toBe(1);
    expect((await call('GET', `/timeline/buckets?userId=${admin.id}`, carolToken)).status).toBe(400);
    expect((await call('GET', `/timeline/buckets?userId=${bob.id}`, adminToken)).status).toBe(400);
    expect((await call('GET', `/timeline/buckets?userId=${admin.id}&visibility=archive`, bobToken)).status).toBe(400);
  });

  it('partner assets never show as favorites', async () => {
    const { admin, adminToken, bobToken } = await shared();
    const fav = (await env.DB.prepare('SELECT id FROM assets WHERE owner_id = ?1').bind(admin.id).first<string>('id'))!;
    await commit(env.DB, [tracked('UPDATE assets SET is_favorite = 1, update_id = :cursor WHERE id = ?1', fav)]);
    await call('PUT', `/partners/${admin.id}`, bobToken, { inTimeline: true });
    const buckets = (await (await call('GET', '/timeline/buckets?visibility=timeline&withPartners=true', bobToken)).json()) as Array<{ timeBucket: string }>;
    const body = (await (await call('GET', `/timeline/bucket?visibility=timeline&withPartners=true&timeBucket=${buckets[0].timeBucket}`, bobToken)).json()) as { id: string[]; isFavorite: boolean[] };
    expect(body.isFavorite[body.id.indexOf(fav)]).toBe(false);
    const own = (await (await call('GET', `/timeline/bucket?visibility=timeline&timeBucket=${buckets[0].timeBucket}`, adminToken)).json()) as { isFavorite: boolean[] };
    expect(own.isFavorite).toEqual([true]);
  });
});
