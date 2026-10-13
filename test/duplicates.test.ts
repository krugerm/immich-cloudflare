import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { detectDuplicates } from '../src/duplicates/detect';
import { toBlob } from '../src/ml/contract';
import { vectorStore } from '../src/ml/vectors';
import { call, photo, twoUsers } from './album-helpers';
import { expectResponse } from './contract';

const OLD = '2024-01-01T00:00:00.000Z';

/** A unit vector at `deg` degrees; the cosine distance between two of them is 1 - cos(angle). */
const at = (deg: number) => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];

async function embed(id: string, ownerId: string, vector: number[], mlAt = OLD, indexed = true) {
  await env.DB.prepare(`UPDATE assets SET status = 'ready', ml_at = ?2 WHERE id = ?1`).bind(id, mlAt).run();
  await env.DB.prepare(`INSERT INTO smart_search (asset_id, embedding, model) VALUES (?1, ?2, 'test')`).bind(id, toBlob(vector)).run();
  if (indexed) await vectorStore(env, 'clip')!.upsert([{ id, values: vector, metadata: { ownerId } }]);
}

const row = (id: string) => env.DB.prepare('SELECT * FROM assets WHERE id = ?1').bind(id).first<Record<string, any>>();
const groupOf = async (id: string) => (await row(id))!.duplicate_id as string | null;

async function setup(n = 3) {
  const u = await twoUsers();
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push(await photo(u.a, `IMG_${i}.JPG`, `2024-05-0${i + 1}T10:00:00.000Z`));
  return { ...u, ids };
}

describe('detectDuplicates', () => {
  it('groups near neighbours and leaves distant assets alone', async () => {
    const { admin, ids } = await setup();
    await embed(ids[0], admin.id, at(0));
    await embed(ids[1], admin.id, at(5));
    await embed(ids[2], admin.id, at(90));
    const res = await detectDuplicates(env, admin.id, 10);
    expect(res.checked).toBe(2); // the second near asset was stamped by the first, as in Immich
    const g = await groupOf(ids[0]);
    expect(g).toBeTruthy();
    expect(await groupOf(ids[1])).toBe(g);
    expect(await groupOf(ids[2])).toBeNull();
    for (const id of ids) expect((await row(id))!.duplicates_checked_at).not.toBeNull();
    // checked assets are not examined again
    expect((await detectDuplicates(env, admin.id, 10)).checked).toBe(0);
  });

  it('writes group ids through the sync cursor', async () => {
    const { admin, ids } = await setup(2);
    const before = (await row(ids[0]))!.update_id;
    await embed(ids[0], admin.id, at(0));
    await embed(ids[1], admin.id, at(1));
    await detectDuplicates(env, admin.id, 10);
    expect((await row(ids[0]))!.update_id > before).toBe(true);
  });

  it('merges two groups when a new asset bridges them', async () => {
    const { admin, a, ids } = await setup(5);
    // A-B and C-D are each within 0.03 (about 14 degrees); B-C are 15 degrees apart (about 0.034).
    await embed(ids[0], admin.id, at(0));
    await embed(ids[1], admin.id, at(5));
    await embed(ids[2], admin.id, at(20));
    await embed(ids[3], admin.id, at(25));
    await detectDuplicates(env, admin.id, 10);
    const g1 = await groupOf(ids[0]);
    const g2 = await groupOf(ids[2]);
    expect(g1).toBeTruthy();
    expect(g2).toBeTruthy();
    expect(g1).not.toBe(g2);
    await embed(ids[4], admin.id, at(12.5), '2024-02-01T00:00:00.000Z');
    await detectDuplicates(env, admin.id, 10);
    const all = await Promise.all(ids.map(groupOf));
    expect(new Set(all).size).toBe(1);
    expect(all[0]).toBeTruthy();
    const res = await call(a, 'GET', '/duplicates');
    expect(res.body).toHaveLength(1);
    expect(res.body[0].assets).toHaveLength(5);
  });

  it('never groups across owners', async () => {
    const { admin, bob, b, ids } = await setup(2);
    const theirs = await photo(b, 'THEIRS.JPG');
    await embed(ids[0], admin.id, at(0));
    await embed(ids[1], admin.id, at(90));
    await embed(theirs, bob.id, at(0));
    await detectDuplicates(env, admin.id, 10);
    await detectDuplicates(env, bob.id, 10);
    expect(await groupOf(ids[0])).toBeNull();
    expect(await groupOf(theirs)).toBeNull();
  });

  it('excludes trashed, stacked and non-default visibility neighbours', async () => {
    const { admin, ids } = await setup(5);
    await embed(ids[0], admin.id, at(0));
    await embed(ids[1], admin.id, at(1));
    await embed(ids[2], admin.id, at(2));
    await embed(ids[3], admin.id, at(3));
    await embed(ids[4], admin.id, at(4));
    await env.DB.prepare(`UPDATE assets SET deleted_at = ?2 WHERE id = ?1`).bind(ids[1], OLD).run();
    await env.DB.prepare(`UPDATE assets SET visibility = 'locked' WHERE id = ?1`).bind(ids[2]).run();
    await env.DB.prepare(`UPDATE assets SET visibility = 'hidden' WHERE id = ?1`).bind(ids[3]).run();
    await detectDuplicates(env, admin.id, 10);
    const g = await groupOf(ids[0]);
    expect(g).toBeTruthy();
    expect(await groupOf(ids[4])).toBe(g);
    for (const i of [1, 2, 3]) expect(await groupOf(ids[i])).toBeNull();
  });

  it('skips stacked assets', async () => {
    const { admin, ids } = await setup(2);
    await embed(ids[0], admin.id, at(0));
    await embed(ids[1], admin.id, at(1));
    await env.DB.prepare(`UPDATE assets SET stack_id = 's1' WHERE id = ?1`).bind(ids[1]).run();
    await detectDuplicates(env, admin.id, 10);
    expect(await groupOf(ids[0])).toBeNull();
    expect(await groupOf(ids[1])).toBeNull();
  });

  it('waits 60 seconds after the ML stamp and respects the limit', async () => {
    const { admin, ids } = await setup(3);
    await embed(ids[0], admin.id, at(45), new Date().toISOString());
    await embed(ids[1], admin.id, at(90));
    await embed(ids[2], admin.id, at(135));
    expect((await detectDuplicates(env, admin.id, 1)).checked).toBe(1);
    expect((await detectDuplicates(env, admin.id, 10)).checked).toBe(1);
    expect((await row(ids[0]))!.duplicates_checked_at).toBeNull();
  });

  it('uses machineLearning.duplicateDetection.maxDistance', async () => {
    const { admin, ids } = await setup(2);
    await embed(ids[0], admin.id, at(0));
    await embed(ids[1], admin.id, at(20)); // distance about 0.06: outside the 0.03 default
    await detectDuplicates(env, admin.id, 10);
    expect(await groupOf(ids[0])).toBeNull();
    await env.DB.prepare(`UPDATE assets SET duplicates_checked_at = NULL`).run();
    await env.DB.prepare(`INSERT INTO system_config (id, value, updated_at) VALUES (1, ?1, ?2)`)
      .bind(JSON.stringify({ machineLearning: { duplicateDetection: { maxDistance: 0.1 } } }), OLD)
      .run();
    await detectDuplicates(env, admin.id, 10);
    expect(await groupOf(ids[0])).toBeTruthy();
    expect(await groupOf(ids[0])).toBe(await groupOf(ids[1]));
  });

  it('clears the group id of an asset that no longer has neighbours', async () => {
    const { admin, ids } = await setup(2);
    await embed(ids[0], admin.id, at(0));
    await embed(ids[1], admin.id, at(1));
    await detectDuplicates(env, admin.id, 10);
    expect(await groupOf(ids[0])).toBeTruthy();
    await vectorStore(env, 'clip')!.deleteByIds([ids[1]]);
    await env.DB.prepare(`UPDATE assets SET duplicates_checked_at = NULL WHERE id = ?1`).bind(ids[0]).run();
    await detectDuplicates(env, admin.id, 10);
    expect(await groupOf(ids[0])).toBeNull();
  });
});

async function grouped(n = 3) {
  const s = await setup(n);
  for (let i = 0; i < n; i++) await embed(s.ids[i], s.admin.id, at(i));
  await detectDuplicates(env, s.admin.id, 50);
  const duplicateId = (await groupOf(s.ids[0]))!;
  return { ...s, duplicateId };
}

describe('GET /duplicates', () => {
  it('returns groups with assets, tags and a suggested keeper', async () => {
    const { a, ids, duplicateId } = await grouped();
    await env.DB.prepare(`INSERT INTO asset_exif (asset_id, owner_id, file_size_in_byte, update_id) VALUES (?1, (SELECT owner_id FROM assets WHERE id = ?1), 100, 'x')`).bind(ids[0]).run();
    await env.DB.prepare(`INSERT INTO asset_exif (asset_id, owner_id, file_size_in_byte, update_id) VALUES (?1, (SELECT owner_id FROM assets WHERE id = ?1), 900, 'x')`).bind(ids[1]).run();
    const res = await call(a, 'GET', '/duplicates');
    expect(res.status).toBe(200);
    expectResponse('/duplicates', 'get', 200, res.body);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].duplicateId).toBe(duplicateId);
    expect(res.body[0].assets.map((x: any) => x.id)).toEqual(ids); // oldest first
    expect(res.body[0].assets[0].duplicateId).toBe(duplicateId);
    expect(res.body[0].suggestedKeepAssetIds).toEqual([ids[1]]);
  });

  it('is empty without groups, requires auth and hides other users', async () => {
    const s = await grouped();
    const empty = await call(s.c, 'GET', '/duplicates');
    expect(empty.body).toEqual([]);
    expectResponse('/duplicates', 'get', 200, empty.body);
    expect((await call(s.b, 'GET', '/duplicates')).body).toEqual([]);
    expect((await call(null, 'GET', '/duplicates')).status).toBe(401);
  });

  it('drops trashed members and cleans up singleton groups', async () => {
    const { a, ids } = await grouped(3);
    await env.DB.prepare(`UPDATE assets SET deleted_at = ?2 WHERE id = ?1`).bind(ids[0], OLD).run();
    expect((await call(a, 'GET', '/duplicates')).body[0].assets).toHaveLength(2);
    await env.DB.prepare(`UPDATE assets SET deleted_at = ?2 WHERE id = ?1`).bind(ids[1], OLD).run();
    const res = await call(a, 'GET', '/duplicates');
    expect(res.body).toEqual([]);
    expect(await groupOf(ids[2])).toBeNull();
  });
});

describe('dismissing groups', () => {
  it('DELETE /duplicates/{id} clears one group', async () => {
    const { a, ids, duplicateId } = await grouped();
    const res = await call(a, 'DELETE', `/duplicates/${duplicateId}`);
    expect(res.status).toBe(204);
    for (const id of ids) expect(await groupOf(id)).toBeNull();
    expect((await call(a, 'GET', '/duplicates')).body).toEqual([]);
  });

  it('DELETE /duplicates clears several groups', async () => {
    const { a, ids, duplicateId } = await grouped();
    const res = await call(a, 'DELETE', '/duplicates', { ids: [duplicateId] });
    expect(res.status).toBe(204);
    for (const id of ids) expect(await groupOf(id)).toBeNull();
  });

  it('answers 400 for groups the caller does not own or that do not exist', async () => {
    const { a, b, duplicateId } = await grouped();
    expect((await call(b, 'DELETE', `/duplicates/${duplicateId}`)).status).toBe(400);
    expect((await call(a, 'DELETE', `/duplicates/${crypto.randomUUID()}`)).status).toBe(400);
    expect((await call(a, 'DELETE', '/duplicates/not-a-uuid')).status).toBe(400);
    expect((await call(a, 'DELETE', '/duplicates', { ids: ['x'] })).status).toBe(400);
    expect(await groupOf((await env.DB.prepare('SELECT id FROM assets WHERE duplicate_id = ?1').bind(duplicateId).first<{ id: string }>())!.id)).toBe(duplicateId);
  });
});

describe('POST /duplicates/resolve', () => {
  it('merges metadata onto the kept asset and trashes the rest', async () => {
    const { a, admin, ids, duplicateId } = await grouped(3);
    const [keep, t1, t2] = ids;
    await env.DB.prepare(`UPDATE assets SET is_favorite = 1, visibility = 'archive' WHERE id = ?1`).bind(t1).run();
    await env.DB.prepare(`INSERT INTO asset_exif (asset_id, owner_id, rating, description, latitude, longitude, update_id) VALUES (?1, ?2, 2, 'one\ntwo', 10, 20, 'x')`).bind(keep, admin.id).run();
    await env.DB.prepare(`INSERT INTO asset_exif (asset_id, owner_id, rating, description, latitude, longitude, update_id) VALUES (?1, ?2, 4, 'two\nthree', 10, 20, 'x')`).bind(t1, admin.id).run();
    const album = (await call(a, 'POST', '/albums', { albumName: 'Trip', assetIds: [t2] })).body.id;
    const tag = (await call(a, 'POST', '/tags', { name: 'holiday' })).body.id;
    await call(a, 'PUT', `/tags/${tag}/assets`, { ids: [t1] });
    const before = await Promise.all(ids.map(async (id) => (await row(id))!.update_id as string));

    const res = await call(a, 'POST', '/duplicates/resolve', { groups: [{ duplicateId, keepAssetIds: [keep], trashAssetIds: [t1, t2] }] });
    expect(res.status).toBe(200);
    expectResponse('/duplicates/resolve', 'post', 200, res.body);
    expect(res.body).toEqual([{ id: duplicateId, success: true }]);

    const kept = (await row(keep))!;
    expect(kept.is_favorite).toBe(1);
    expect(kept.visibility).toBe('archive');
    expect(kept.duplicate_id).toBeNull();
    expect(kept.deleted_at).toBeNull();
    const exif = (await env.DB.prepare('SELECT * FROM asset_exif WHERE asset_id = ?1').bind(keep).first<Record<string, any>>())!;
    expect(exif.rating).toBe(4);
    expect(exif.description).toBe('one\ntwo\nthree');
    expect([exif.latitude, exif.longitude]).toEqual([10, 20]);
    const inAlbum = await env.DB.prepare('SELECT 1 AS x FROM album_assets WHERE album_id = ?1 AND asset_id = ?2').bind(album, keep).first();
    expect(inAlbum).not.toBeNull();
    const kTags = await env.DB.prepare('SELECT tag_id FROM tag_asset WHERE asset_id = ?1').bind(keep).all();
    expect(kTags.results.map((r: any) => r.tag_id)).toEqual([tag]);
    for (const id of [t1, t2]) {
      const r = (await row(id))!;
      expect(r.deleted_at).not.toBeNull();
      expect(r.duplicate_id).toBeNull();
    }
    // every changed asset moved the sync cursor
    const after = await Promise.all(ids.map(async (id) => (await row(id))!.update_id as string));
    after.forEach((u, i) => expect(u > before[i]).toBe(true));
    expect((await call(a, 'GET', '/duplicates')).body).toEqual([]);
  });

  it('only clears the group when several assets are kept', async () => {
    const { a, ids, duplicateId } = await grouped(3);
    await env.DB.prepare(`UPDATE assets SET is_favorite = 1 WHERE id = ?1`).bind(ids[2]).run();
    const res = await call(a, 'POST', '/duplicates/resolve', { groups: [{ duplicateId, keepAssetIds: [ids[0], ids[1]], trashAssetIds: [ids[2]] }] });
    expect(res.body[0].success).toBe(true);
    expect((await row(ids[0]))!.is_favorite).toBe(0);
    expect((await row(ids[0]))!.duplicate_id).toBeNull();
    expect((await row(ids[2]))!.deleted_at).not.toBeNull();
  });

  it('reports validation errors per group', async () => {
    const { a, ids, duplicateId } = await grouped(3);
    const missing = await call(a, 'POST', '/duplicates/resolve', { groups: [{ duplicateId, keepAssetIds: [ids[0]], trashAssetIds: [ids[1]] }] });
    expect(missing.body[0]).toMatchObject({ id: duplicateId, success: false, error: 'validation' });
    const both = await call(a, 'POST', '/duplicates/resolve', { groups: [{ duplicateId, keepAssetIds: ids, trashAssetIds: [ids[0]] }] });
    expect(both.body[0]).toMatchObject({ success: false, error: 'validation' });
    for (const id of ids) expect((await row(id))!.deleted_at).toBeNull();
  });

  it('rejects bad bodies and groups the caller does not own', async () => {
    const { a, b, ids, duplicateId } = await grouped();
    expect((await call(a, 'POST', '/duplicates/resolve', { groups: [] })).status).toBe(400);
    expect((await call(a, 'POST', '/duplicates/resolve', {})).status).toBe(400);
    expect((await call(a, 'POST', '/duplicates/resolve', { groups: [{ duplicateId: 'x', keepAssetIds: [], trashAssetIds: [] }] })).status).toBe(400);
    expect((await call(b, 'POST', '/duplicates/resolve', { groups: [{ duplicateId, keepAssetIds: [ids[0]], trashAssetIds: [ids[1], ids[2]] }] })).status).toBe(400);
    expect((await call(a, 'POST', '/duplicates/resolve', { groups: [{ duplicateId: crypto.randomUUID(), keepAssetIds: [], trashAssetIds: [] }] })).status).toBe(400);
    expect((await row(ids[1]))!.deleted_at).toBeNull();
  });

  it('ignores asset ids outside the group', async () => {
    const { a, b, ids, duplicateId } = await grouped(2);
    const foreign = await photo(b, 'F.JPG');
    const res = await call(a, 'POST', '/duplicates/resolve', { groups: [{ duplicateId, keepAssetIds: [ids[0]], trashAssetIds: [ids[1], foreign] }] });
    expect(res.body[0].success).toBe(true);
    expect((await row(foreign))!.deleted_at).toBeNull();
  });

  it('deletes outright when the trash is disabled', async () => {
    const { a, ids, duplicateId } = await grouped(2);
    await env.DB.prepare(`INSERT INTO system_config (id, value, updated_at) VALUES (1, ?1, ?2)`).bind(JSON.stringify({ trash: { enabled: false } }), OLD).run();
    const res = await call(a, 'POST', '/duplicates/resolve', { groups: [{ duplicateId, keepAssetIds: [ids[0]], trashAssetIds: [ids[1]] }] });
    expect(res.body[0].success).toBe(true);
    expect(await row(ids[1])).toBeNull();
    expect(await row(ids[0])).not.toBeNull();
  });
});
