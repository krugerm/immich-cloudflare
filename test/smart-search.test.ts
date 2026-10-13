import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { storeClip } from '../src/ml/clip';
import { MlUnavailableError, type MlClient } from '../src/ml/contract';
import { fakeVectorStore } from '../src/ml/vectors';
import { setSmartSearchClient } from '../src/search/smart';
import type { AssetRow } from '../src/db/rows';
import { expectResponse } from './contract';
import { authHeaders, BASE, createUser, login, uploadAsset } from './helpers';

let embedCalls: string[] = [];
let embeddings: Record<string, number[]> = {};
let failText = false;

const fakeMl: MlClient = {
  async predict() {
    throw new Error('unused');
  },
  async embedText(text) {
    embedCalls.push(text);
    if (failText) throw new MlUnavailableError('down');
    return embeddings[text] ?? [0, 0, 1];
  },
};

beforeEach(() => {
  embedCalls = [];
  embeddings = { beach: [1, 0, 0], dog: [0, 1, 0] };
  failText = false;
  setSmartSearchClient(fakeMl);
});
afterEach(() => setSmartSearchClient(undefined));

async function post(token: string, body: unknown) {
  const res = await SELF.fetch(`${BASE}/api/search/smart`, { method: 'POST', headers: { ...authHeaders(token), 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
}

let n = 0;
/** Uploads a ready asset for `token`'s user and embeds it with `vec`. */
async function asset(token: string, vec: number[] | null, opts: { vis?: string; trashed?: boolean; fav?: boolean } = {}): Promise<string> {
  n += 1;
  const id = (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(40 + n)), { filename: `a${n}.jpg` })).body.id as string;
  await env.DB.prepare("UPDATE assets SET status = 'ready', visibility = ?2, deleted_at = ?3, is_favorite = ?4 WHERE id = ?1")
    .bind(id, opts.vis ?? 'timeline', opts.trashed ? '2024-01-01T00:00:00.000Z' : null, opts.fav ? 1 : 0)
    .run();
  const row = await env.DB.prepare('SELECT * FROM assets WHERE id = ?1').bind(id).first<AssetRow>();
  if (vec) await storeClip(env, row!, vec);
  return id;
}

async function twoUsers() {
  const admin = await createUser();
  const token = await login();
  const bob = await createUser({ email: 'bob@example.com', isAdmin: false });
  const bobToken = await login('bob@example.com');
  return { admin, token, bob, bobToken };
}

const ids = (r: { body: any }) => (r.body.assets.items as Array<{ id: string }>).map((a) => a.id);

describe('POST /search/smart', () => {
  it('ranks by cosine similarity, validates the response and stores the embedding', async () => {
    const { token } = await twoUsers();
    const dog = await asset(token, [0, 1, 0]);
    const beach = await asset(token, [1, 0.1, 0]);
    const mixed = await asset(token, [1, 1, 0]);
    const r = await post(token, { query: 'beach' });
    expect(r.status).toBe(200);
    expectResponse('/search/smart', 'post', 200, r.body);
    expect(ids(r)).toEqual([beach, mixed, dog]);
    expect(r.body.assets.nextPage).toBeNull();
    expect(r.body.albums.items).toEqual([]);
    const row = await env.DB.prepare('SELECT length(embedding) AS n, model FROM smart_search WHERE asset_id = ?1').bind(beach).first<any>();
    expect(row).toEqual({ n: 12, model: 'ViT-B-16-SigLIP2__webli' });
    const without = await post(token, { query: 'beach', withExif: false });
    expect(without.body.assets.items[0].exifInfo).toBeUndefined();
  });

  it('never returns another user\'s assets, even when they rank first', async () => {
    const { token, bobToken } = await twoUsers();
    const bobs = await asset(bobToken, [1, 0, 0]);
    const mine = await asset(token, [0, 1, 0]);
    expect(ids(await post(token, { query: 'beach' }))).toEqual([mine]);
    expect(ids(await post(bobToken, { query: 'beach' }))).toEqual([bobs]);
  });

  it('re-checks ownership in D1 when the index holds a stale owner', async () => {
    const { token, bobToken } = await twoUsers();
    const bobs = await asset(bobToken, [1, 0, 0]);
    // The index claims the asset belongs to the caller; D1 says it is Bob's.
    const me = (await SELF.fetch(`${BASE}/api/users/me`, { headers: authHeaders(token) }).then((r) => r.json())) as any;
    await fakeVectorStore('clip').upsert([{ id: bobs, values: [1, 0, 0], metadata: { ownerId: me.id } }]);
    expect(ids(await post(token, { query: 'beach' }))).toEqual([]);
  });

  it('includes partners who share their timeline, but not partners with timeline off or in the other direction', async () => {
    const { admin, token, bob, bobToken } = await twoUsers();
    const carol = await createUser({ email: 'carol@example.com', isAdmin: false });
    const carolToken = await login('carol@example.com');
    const mine = await asset(token, [1, 0, 0]);
    const bobs = await asset(bobToken, [1, 0.2, 0]);
    const bobsLocked = await asset(bobToken, [1, 0.1, 0], { vis: 'locked' });
    const carols = await asset(carolToken, [1, 0.3, 0]);
    const share = (by: string, to: string, tl: number) =>
      env.DB.prepare('INSERT INTO partners (shared_by_id, shared_with_id, in_timeline, created_at, updated_at, create_id, update_id) VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?5)')
        .bind(by, to, tl, '2024-01-01T00:00:00.000Z', crypto.randomUUID()).run();
    await share(bob.id, admin.id, 1);
    await share(carol.id, admin.id, 0);
    expect(ids(await post(token, { query: 'beach' }))).toEqual([mine, bobs]);
    // Bob does not see the admin's assets: the share points one way.
    expect(ids(await post(bobToken, { query: 'beach' }))).toEqual([bobs]);
    expect([bobsLocked, carols]).not.toContain(bobs);
  });

  it('handles trashed, archived, hidden and locked assets as Immich does', async () => {
    const { token } = await twoUsers();
    const visible = await asset(token, [1, 0, 0]);
    const archived = await asset(token, [1, 0.1, 0], { vis: 'archive' });
    const trashed = await asset(token, [1, 0.2, 0], { trashed: true });
    const locked = await asset(token, [1, 0.3, 0], { vis: 'locked' });
    const hidden = await asset(token, [1, 0.4, 0], { vis: 'hidden' });
    expect(ids(await post(token, { query: 'beach' }))).toEqual([visible, archived]);
    expect(ids(await post(token, { query: 'beach', visibility: 'archive' }))).toEqual([archived]);
    expect(ids(await post(token, { query: 'beach', visibility: 'timeline' }))).toEqual([visible]);
    expect(ids(await post(token, { query: 'beach', withDeleted: true }))).toEqual([visible, archived, trashed]);
    expect((await post(token, { query: 'beach', visibility: 'locked' })).status).toBe(401);
    expect(locked && hidden).toBeTruthy();
    // hidden assets are never embedded
    expect(await env.DB.prepare('SELECT 1 AS x FROM smart_search WHERE asset_id = ?1').bind(hidden).first()).toBeNull();
  });

  it('a purged asset leaves the results even if its vector lingers; a restored one returns', async () => {
    const { token } = await twoUsers();
    const a = await asset(token, [1, 0, 0]);
    const b = await asset(token, [0.9, 0.1, 0]);
    await env.DB.prepare("UPDATE assets SET deleted_at = '2024-01-01T00:00:00.000Z' WHERE id = ?1").bind(a).run();
    expect(ids(await post(token, { query: 'beach' }))).toEqual([b]);
    await env.DB.prepare('UPDATE assets SET deleted_at = NULL WHERE id = ?1').bind(a).run();
    expect(ids(await post(token, { query: 'beach' }))).toEqual([a, b]);
    await env.DB.prepare('DELETE FROM assets WHERE id = ?1').bind(a).run();
    expect(ids(await post(token, { query: 'beach' }))).toEqual([b]);
  });

  it('applies request filters on top of the ranking', async () => {
    const { token } = await twoUsers();
    const plain = await asset(token, [1, 0, 0]);
    const fav = await asset(token, [0, 1, 0], { fav: true });
    expect(ids(await post(token, { query: 'beach', isFavorite: true }))).toEqual([fav]);
    expect(ids(await post(token, { query: 'beach', filter: { isFavorite: { eq: false } } }))).toEqual([plain]);
  });

  it('pages within the top 100 and sets nextPage', async () => {
    const { token } = await twoUsers();
    const all: string[] = [];
    for (let i = 0; i < 5; i++) all.push(await asset(token, [1, i * 0.1, 0]));
    const p1 = await post(token, { query: 'beach', size: 2 });
    expect(ids(p1)).toEqual(all.slice(0, 2));
    expect(p1.body.assets.nextPage).toBe('2');
    const p2 = await post(token, { query: 'beach', size: 2, page: 2 });
    expect(ids(p2)).toEqual(all.slice(2, 4));
    expect(p2.body.assets.nextPage).toBe('3');
    const p3 = await post(token, { query: 'beach', size: 2, page: 3 });
    expect(ids(p3)).toEqual(all.slice(4));
    expect(p3.body.assets.nextPage).toBeNull();
    expectResponse('/search/smart', 'post', 200, p3.body);
    expect(ids(await post(token, { query: 'beach', size: 2, page: 4 }))).toEqual([]);
  });

  it('ignores index entries without a D1 row among the 100 nearest', async () => {
    const { token } = await twoUsers();
    const me = (await SELF.fetch(`${BASE}/api/users/me`, { headers: authHeaders(token) }).then((r) => r.json())) as any;
    const first = await asset(token, [1, 0, 0]);
    const vectors = Array.from({ length: 120 }, (_, i) => ({ id: crypto.randomUUID(), values: [1, (i + 1) * 0.01, 0], metadata: { ownerId: me.id } }));
    await fakeVectorStore('clip').upsert(vectors); // no D1 rows: dropped by the re-check
    const r = await post(token, { query: 'beach' });
    expect(ids(r)).toEqual([first]);
  });

  it('caches query embeddings per isolate', async () => {
    const { token } = await twoUsers();
    await asset(token, [1, 0, 0]);
    await post(token, { query: 'beach' });
    await post(token, { query: ' beach ' });
    await post(token, { query: 'dog' });
    expect(embedCalls).toEqual(['beach', 'dog']);
  });

  it('queryAssetId searches by the stored embedding, source first', async () => {
    const { token, bobToken } = await twoUsers();
    const src = await asset(token, [0, 1, 0]);
    const near = await asset(token, [0.1, 1, 0]);
    const far = await asset(token, [1, 0, 0]);
    const bobs = await asset(bobToken, [0, 1, 0]);
    const noEmbedding = await asset(token, null);
    expect(ids(await post(token, { queryAssetId: src }))).toEqual([src, near, far]);
    expect(embedCalls).toEqual([]);
    expect((await post(token, { queryAssetId: noEmbedding })).status).toBe(400);
    expect((await post(token, { queryAssetId: bobs })).status).toBe(400); // not readable
    expect((await post(token, { queryAssetId: crypto.randomUUID() })).status).toBe(400);
    // query wins when both are given
    expect(ids(await post(token, { query: 'beach', queryAssetId: src }))[0]).toBe(far);
  });

  it('answers 400 for bad input and 503 when the ML service is down', async () => {
    const { token } = await twoUsers();
    expect((await post(token, {})).status).toBe(400);
    expect((await post(token, { query: '   ' })).status).toBe(400);
    expect((await post(token, { query: 5 })).status).toBe(400);
    expect((await post(token, { queryAssetId: 'nope' })).status).toBe(400);
    expect((await post(token, { query: 'beach', size: 0 })).status).toBe(400);
    expect((await post(token, { query: 'beach', size: 1001 })).status).toBe(400);
    expect((await post(token, { query: 'beach', page: 0 })).status).toBe(400);
    expect((await post(token, { query: 'beach', withExif: 'yes' })).status).toBe(400);
    expect((await post(token, { query: 'beach', filter: {}, isFavorite: true })).status).toBe(400);
    failText = true;
    expect((await post(token, { query: 'cat' })).status).toBe(503);
    setSmartSearchClient(undefined);
    expect((await post(token, { query: 'beach' })).status).toBe(503); // real client: ML container bound but not running in tests
    const unauth = await SELF.fetch(`${BASE}/api/search/smart`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(unauth.status).toBe(401);
  });
});
