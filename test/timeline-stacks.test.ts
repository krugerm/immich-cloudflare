import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { expectResponse } from './contract';
import { authHeaders, BASE, createUser, login, uploadAsset } from './helpers';
import { call } from './tags.test';

async function setup() {
  await createUser();
  const token = await login();
  const ids: string[] = [];
  // Two in May (days 4 and 20), one in December.
  for (const d of ['2024-05-04T10:00:00.000Z', '2024-05-20T10:00:00.000Z', '2024-05-21T10:00:00.000Z', '2023-12-31T23:00:00.000Z']) {
    ids.push((await uploadAsset(token, crypto.getRandomValues(new Uint8Array(100 + ids.length)), { fields: { fileCreatedAt: d, fileModifiedAt: d } })).body.id);
  }
  return { token, ids };
}

const get = async (token: string, q: string) => (await SELF.fetch(`${BASE}/api/timeline/${q}`, { headers: authHeaders(token) })).json() as Promise<any>;

describe('timeline tagId filter', () => {
  it('returns only tagged assets, including those under descendant tags', async () => {
    const { token, ids } = await setup();
    const leaf = (await call(token, 'PUT', '/tags', { tags: ['trip/paris'] })).body[0];
    const other = (await call(token, 'POST', '/tags', { name: 'other' })).body;
    const parent = (await call(token, 'GET', '/tags')).body.find((t: any) => t.value === 'trip');
    await call(token, 'PUT', `/tags/${leaf.id}/assets`, { ids: [ids[0], ids[3]] });
    await call(token, 'PUT', `/tags/${other.id}/assets`, { ids: [ids[1]] });
    expect(await get(token, `buckets?tagId=${leaf.id}`)).toEqual([
      { timeBucket: '2024-05-01', count: 1 },
      { timeBucket: '2023-12-01', count: 1 },
    ]);
    expect(await get(token, `buckets?tagId=${parent.id}`)).toHaveLength(2);
    const bucket = await get(token, `bucket?timeBucket=2024-05-01&tagId=${other.id}`);
    expectResponse('/timeline/bucket', 'get', 200, bucket);
    expect(bucket.id).toEqual([ids[1]]);
    expect((await SELF.fetch(`${BASE}/api/timeline/buckets?tagId=nope`, { headers: authHeaders(token) })).status).toBe(400);
  });
});

describe('timeline withStacked', () => {
  it('collapses a stack to its primary and reports [stackId, count]', async () => {
    const { token, ids } = await setup();
    const s = (await call(token, 'POST', '/stacks', { assetIds: [ids[1], ids[0], ids[2]] })).body;
    expect(await get(token, 'buckets?withStacked=true')).toEqual([
      { timeBucket: '2024-05-01', count: 1 },
      { timeBucket: '2023-12-01', count: 1 },
    ]);
    expect((await get(token, 'buckets'))[0].count).toBe(3); // without the flag nothing collapses
    const bucket = await get(token, 'bucket?timeBucket=2024-05-01&withStacked=true');
    expectResponse('/timeline/bucket', 'get', 200, bucket);
    expect(bucket.id).toEqual([ids[1]]);
    expect(bucket.stack).toEqual([[s.id, '3']]);
    const dec = await get(token, 'bucket?timeBucket=2023-12-01&withStacked=true');
    expect(dec.stack).toEqual([null]);
    expect((await get(token, 'bucket?timeBucket=2024-05-01')).stack).toBeUndefined();
  });

  it('counts only non-trashed timeline members', async () => {
    const { token, ids } = await setup();
    const s = (await call(token, 'POST', '/stacks', { assetIds: [ids[1], ids[0], ids[2]] })).body;
    await call(token, 'PUT', `/stacks/${s.id}`, { primaryAssetId: ids[1] });
    const { env } = await import('cloudflare:test');
    await env.DB.prepare("UPDATE assets SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1").bind(ids[2]).run();
    const bucket = await get(token, 'bucket?timeBucket=2024-05-01&withStacked=true');
    expect(bucket.stack).toEqual([[s.id, '2']]);
  });

  it('combines with tagId', async () => {
    const { token, ids } = await setup();
    await call(token, 'POST', '/stacks', { assetIds: [ids[0], ids[1]] });
    const tag = (await call(token, 'POST', '/tags', { name: 't' })).body;
    await call(token, 'PUT', `/tags/${tag.id}/assets`, { ids: [ids[1]] });
    // the tagged asset is a non-primary member, so it collapses away
    expect(await get(token, `buckets?tagId=${tag.id}&withStacked=true`)).toEqual([]);
    expect(await get(token, `buckets?tagId=${tag.id}`)).toEqual([{ timeBucket: '2024-05-01', count: 1 }]);
  });

  it('rejects tag ids the caller does not own or that do not exist', async () => {
    const { token } = await setup();
    await createUser({ email: 'other@example.com', name: 'Other', isAdmin: false });
    const other = await login('other@example.com');
    const foreign = (await call(other, 'POST', '/tags', { name: 'theirs' })).body;
    for (const q of [`buckets?tagId=${foreign.id}`, `buckets?tagId=${crypto.randomUUID()}`, `bucket?timeBucket=2024-05-01&tagId=${foreign.id}`, `bucket?timeBucket=2024-05-01&tagId=${crypto.randomUUID()}`, 'buckets?tagId=nope']) {
      expect((await SELF.fetch(`${BASE}/api/timeline/${q}`, { headers: authHeaders(token) })).status, q).toBe(400);
    }
  });
});
