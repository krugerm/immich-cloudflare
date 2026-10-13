import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { expectResponse } from './contract';
import { authHeaders, BASE, createUser, login, uploadAsset } from './helpers';

export async function call(token: string, method: string, path: string, body?: unknown) {
  const res = await SELF.fetch(`${BASE}/api${path}`, {
    method,
    headers: { ...authHeaders(token), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function setup() {
  await createUser();
  await createUser({ email: 'other@example.com', name: 'Other', isAdmin: false });
  const token = await login();
  const other = await login('other@example.com');
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) ids.push((await uploadAsset(token, crypto.getRandomValues(new Uint8Array(100 + i)))).body.id);
  const foreign = (await uploadAsset(other, crypto.getRandomValues(new Uint8Array(200)))).body.id;
  return { token, other, ids, foreign };
}

describe('tags', () => {
  it('creates, reads, lists and nests tags', async () => {
    const { token } = await setup();
    const a = await call(token, 'POST', '/tags', { name: 'animals', color: 'ff0000' });
    expect(a.status).toBe(201);
    expectResponse('/tags', 'post', 201, a.body);
    expect(a.body).toMatchObject({ name: 'animals', value: 'animals', color: '#ff0000' });
    expect(a.body.parentId).toBeUndefined();
    const b = await call(token, 'POST', '/tags', { name: 'cats', parentId: a.body.id });
    expect(b.body).toMatchObject({ name: 'cats', value: 'animals/cats', parentId: a.body.id });
    const list = await call(token, 'GET', '/tags');
    expectResponse('/tags', 'get', 200, list.body);
    expect(list.body.map((t: any) => t.value)).toEqual(['animals', 'animals/cats']);
    const one = await call(token, 'GET', `/tags/${b.body.id}`);
    expectResponse('/tags/{id}', 'get', 200, one.body);
    expect(one.body.id).toBe(b.body.id);
  });

  it('rejects duplicates, slashes, bad colours and bad ids with 400', async () => {
    const { token } = await setup();
    await call(token, 'POST', '/tags', { name: 'x' });
    expect((await call(token, 'POST', '/tags', { name: 'x' })).status).toBe(400);
    expect((await call(token, 'POST', '/tags', { name: 'a/b' })).status).toBe(400);
    expect((await call(token, 'POST', '/tags', { name: 'y', color: 'zzz' })).status).toBe(400);
    expect((await call(token, 'POST', '/tags', { name: 'y', parentId: 'nope' })).status).toBe(400);
    expect((await call(token, 'POST', '/tags', { name: 'y', parentId: crypto.randomUUID() })).status).toBe(400);
    expect((await call(token, 'GET', '/tags/not-a-uuid')).status).toBe(400);
    expect((await call(token, 'PUT', '/tags/assets', { tagIds: 'x', assetIds: [] })).status).toBe(400);
    expect((await SELF.fetch(`${BASE}/api/tags`, { method: 'POST', headers: { ...authHeaders(token), 'content-type': 'application/json' }, body: 'nope' })).status).toBe(400);
  });

  it('requires auth and hides other users tags', async () => {
    const { token, other } = await setup();
    const t = await call(token, 'POST', '/tags', { name: 'mine' });
    expect((await SELF.fetch(`${BASE}/api/tags`)).status).toBe(401);
    for (const [m, p, b] of [['GET', `/tags/${t.body.id}`], ['PUT', `/tags/${t.body.id}`, { name: 'z' }], ['DELETE', `/tags/${t.body.id}`], ['PUT', `/tags/${t.body.id}/assets`, { ids: [] }], ['DELETE', `/tags/${t.body.id}/assets`, { ids: [] }]] as const) {
      expect((await call(other, m, p, b)).status, `${m} ${p}`).toBe(400);
    }
    expect((await call(other, 'GET', '/tags')).body).toEqual([]);
    expect((await call(other, 'POST', '/tags', { name: 'child', parentId: t.body.id })).status).toBe(400);
  });

  it('upserts paths into hierarchies and is idempotent', async () => {
    const { token } = await setup();
    const res = await call(token, 'PUT', '/tags', { tags: ['a/b/c', 'a/d', 'a/b/c'] });
    expect(res.status).toBe(200);
    expectResponse('/tags', 'put', 200, res.body);
    expect(res.body.map((t: any) => t.value)).toEqual(['a/b/c', 'a/d']);
    const again = await call(token, 'PUT', '/tags', { tags: ['a/b/c'] });
    expect(again.body[0].id).toBe(res.body[0].id);
    const all = (await call(token, 'GET', '/tags')).body;
    expect(all.map((t: any) => t.value)).toEqual(['a', 'a/b', 'a/b/c', 'a/d']);
    expect(all[2].parentId).toBe(all[1].id);
    expect((await call(token, 'PUT', '/tags', { tags: [1] })).status).toBe(400);
  });

  it('renames a tag and rewrites descendant values; colour can be cleared', async () => {
    const { token } = await setup();
    const leaf = (await call(token, 'PUT', '/tags', { tags: ['a/b/c'] })).body[0];
    const all = (await call(token, 'GET', '/tags')).body;
    const b = all.find((t: any) => t.value === 'a/b');
    const upd = await call(token, 'PUT', `/tags/${b.id}`, { name: 'bee', color: '#abc' });
    expectResponse('/tags/{id}', 'put', 200, upd.body);
    expect(upd.body).toMatchObject({ value: 'a/bee', name: 'bee', color: '#abc' });
    expect((await call(token, 'GET', `/tags/${leaf.id}`)).body.value).toBe('a/bee/c');
    const cleared = await call(token, 'PUT', `/tags/${b.id}`, { color: null });
    expect(cleared.body.color).toBeUndefined();
    expect(cleared.body.value).toBe('a/bee');
    await call(token, 'POST', '/tags', { name: 'taken', parentId: (await call(token, 'GET', '/tags')).body[0].id });
    expect((await call(token, 'PUT', `/tags/${b.id}`, { name: 'taken' })).status).toBe(400);
  });

  it('deletes a tag with its children and asset links', async () => {
    const { token, ids } = await setup();
    const leaf = (await call(token, 'PUT', '/tags', { tags: ['a/b'] })).body[0];
    const parent = (await call(token, 'GET', '/tags')).body[0];
    await call(token, 'PUT', `/tags/${leaf.id}/assets`, { ids: [ids[0]] });
    expect((await call(token, 'DELETE', `/tags/${parent.id}`)).status).toBe(204);
    expect((await call(token, 'GET', '/tags')).body).toEqual([]);
    expect((await env.DB.prepare('SELECT count(*) AS n FROM tag_asset').first<{ n: number }>())!.n).toBe(0);
  });

  it('tags and untags assets by tag id with per-asset results', async () => {
    const { token, ids, foreign } = await setup();
    const tag = (await call(token, 'POST', '/tags', { name: 't' })).body;
    const missing = crypto.randomUUID();
    const add = await call(token, 'PUT', `/tags/${tag.id}/assets`, { ids: [ids[0], ids[1], ids[0], foreign, missing] });
    expect(add.status).toBe(200);
    expectResponse('/tags/{id}/assets', 'put', 200, add.body);
    expect(add.body.map((r: any) => [r.success, r.error])).toEqual([
      [true, undefined], [true, undefined], [false, 'duplicate'], [false, 'no_permission'], [false, 'no_permission'],
    ]);
    const again = await call(token, 'PUT', `/tags/${tag.id}/assets`, { ids: [ids[0]] });
    expect(again.body[0]).toMatchObject({ success: false, error: 'duplicate' });
    const del = await call(token, 'DELETE', `/tags/${tag.id}/assets`, { ids: [ids[0], ids[2]] });
    expectResponse('/tags/{id}/assets', 'delete', 200, del.body);
    expect(del.body.map((r: any) => [r.success, r.error])).toEqual([[true, undefined], [false, 'not_found']]);
    expect((await call(token, 'GET', `/assets/${ids[1]}`)).body.tags.map((t: any) => t.value)).toEqual(['t']);
    expect((await call(token, 'GET', `/assets/${ids[0]}`)).body.tags).toEqual([]);
  });

  it('bulk tags only own tags and assets and counts new links', async () => {
    const { token, other, ids, foreign } = await setup();
    const t1 = (await call(token, 'POST', '/tags', { name: 't1' })).body;
    const t2 = (await call(token, 'POST', '/tags', { name: 't2' })).body;
    const foreignTag = (await call(other, 'POST', '/tags', { name: 'f' })).body;
    const res = await call(token, 'PUT', '/tags/assets', { tagIds: [t1.id, t2.id, foreignTag.id], assetIds: [ids[0], ids[1], foreign] });
    expect(res.status).toBe(200);
    expectResponse('/tags/assets', 'put', 200, res.body);
    expect(res.body).toEqual({ count: 4 });
    expect((await call(token, 'PUT', '/tags/assets', { tagIds: [t1.id], assetIds: [ids[0], ids[2]] })).body).toEqual({ count: 1 });
    expect((await call(token, 'PUT', '/tags/assets', { tagIds: [], assetIds: [] })).body).toEqual({ count: 0 });
  });

  it('caps upsert at 100 values and accepts empty names like Immich', async () => {
    const { token } = await setup();
    expect((await call(token, 'PUT', '/tags', { tags: Array.from({ length: 101 }, (_, i) => `t${i}`) })).status).toBe(400);
    expect((await call(token, 'PUT', '/tags', { tags: Array.from({ length: 100 }, (_, i) => `t${i}`) })).status).toBe(200);
    const empty = await call(token, 'POST', '/tags', { name: '' }); // Immich's DTO has no minimum length
    expect(empty.status).toBe(201);
  });
});
