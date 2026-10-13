import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { expectResponse } from './contract';
import { authHeaders, BASE, uploadAsset } from './helpers';
import { call, setupAssets, sync } from './stream-b';

const asset = (id: string) => env.DB.prepare('SELECT * FROM assets WHERE id = ?1').bind(id).first<any>();
const count = async () => (await env.DB.prepare('SELECT count(*) AS n FROM assets').first<{ n: number }>())!.n;

describe('DELETE /assets', () => {
  it('moves assets to the trash and syncs them as updates, not deletes', async () => {
    const { token, ids } = await setupAssets(3);
    const before = await Promise.all(ids.map(asset));
    expect((await call(token, 'DELETE', '/assets', { ids: ids.slice(0, 2) })).status).toBe(204);
    const rows = await Promise.all(ids.map(asset));
    expect(rows[0].deleted_at).toBeTruthy();
    expect(rows[1].deleted_at).toBeTruthy();
    expect(rows[2].deleted_at).toBeNull();
    expect(new Set(rows.slice(0, 2).map((r) => r.update_id)).size).toBe(2);
    expect(rows[0].update_id > before[0].update_id).toBe(true);
    const lines = await sync(token, ['AssetsV2']);
    expect(lines.filter((l) => l.type === 'AssetDeleteV1')).toHaveLength(0);
    expect(lines.filter((l) => l.type === 'AssetV2' && l.data.deletedAt).map((l) => l.data.id).sort()).toEqual(ids.slice(0, 2).sort());
  });

  it('with force hard-deletes through purge: objects, usage and audit', async () => {
    const { token, ids } = await setupAssets(2);
    const path = (await asset(ids[0])).original_path;
    await env.MEDIA.put(`thumbs/${ids[0]}/thumbnail.webp`, 'x');
    expect((await call(token, 'DELETE', '/assets', { ids: [ids[0]], force: true })).status).toBe(204);
    expect(await asset(ids[0])).toBeNull();
    expect(await env.MEDIA.head(path)).toBeNull();
    expect(await env.MEDIA.head(`thumbs/${ids[0]}/thumbnail.webp`)).toBeNull();
    expect((await env.DB.prepare('SELECT asset_id FROM asset_audit').all()).results).toEqual([{ asset_id: ids[0] }]);
    expect(await env.DB.prepare('SELECT usage_bytes FROM users').first('usage_bytes')).toBe(101);
    expect((await sync(token, ['AssetsV2'])).filter((l) => l.type === 'AssetDeleteV1')).toHaveLength(1);
  });

  it('with force also removes the live photo video that nothing else references', async () => {
    const { token, ids } = await setupAssets(1);
    const video = (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(60)), { filename: 'clip.mov', fields: { visibility: 'hidden' } })).body.id;
    await env.DB.prepare('UPDATE assets SET live_photo_video_id = ?2 WHERE id = ?1').bind(ids[0], video).run();
    const videoPath = (await asset(video)).original_path;
    await call(token, 'DELETE', '/assets', { ids: [ids[0]], force: true });
    expect(await count()).toBe(0);
    expect(await env.MEDIA.head(videoPath)).toBeNull();
    expect((await env.DB.prepare('SELECT asset_id FROM asset_audit').all()).results.map((r: any) => r.asset_id).sort()).toEqual([ids[0], video].sort());
  });

  it('is 400 for other users assets, unknown ids and bad bodies, and deletes nothing', async () => {
    const { token, ids, other } = await setupAssets(1, { second: true });
    expect((await call(other, 'DELETE', '/assets', { ids })).status).toBe(400);
    expect((await call(token, 'DELETE', '/assets', { ids: [crypto.randomUUID()] })).status).toBe(400);
    expect((await call(token, 'DELETE', '/assets', { ids: ['x'] })).status).toBe(400);
    expect((await call(token, 'DELETE', '/assets', { ids, force: 'yes' })).status).toBe(400);
    expect((await call(token, 'DELETE', '/assets', {})).status).toBe(400);
    expect((await asset(ids[0])).deleted_at).toBeNull();
  });
});

describe('trash endpoints', () => {
  it('restores selected assets and reports the count', async () => {
    const { token, ids, other } = await setupAssets(3, { second: true });
    await call(token, 'DELETE', '/assets', { ids });
    const res = await call(token, 'POST', '/trash/restore/assets', { ids: ids.slice(0, 2) });
    expect(res.status).toBe(200);
    expectResponse('/trash/restore/assets', 'post', 200, res.json);
    expect(res.json).toEqual({ count: 2 });
    expect((await asset(ids[0])).deleted_at).toBeNull();
    expect((await asset(ids[2])).deleted_at).toBeTruthy();
    expect((await call(token, 'POST', '/trash/restore/assets', { ids: [] })).json).toEqual({ count: 0 });
    expect((await call(other, 'POST', '/trash/restore/assets', { ids })).status).toBe(400);
    expect((await call(token, 'POST', '/trash/restore/assets', { ids: ['x'] })).status).toBe(400);
  });

  it('restores everything in the trash for the caller only', async () => {
    const { token, ids, other } = await setupAssets(3, { second: true });
    const theirs = (await uploadAsset(other, crypto.getRandomValues(new Uint8Array(77)))).body.id;
    await call(token, 'DELETE', '/assets', { ids });
    await call(other, 'DELETE', '/assets', { ids: [theirs] });
    const res = await call(token, 'POST', '/trash/restore');
    expectResponse('/trash/restore', 'post', 200, res.json);
    expect(res.json).toEqual({ count: 3 });
    expect((await asset(theirs)).deleted_at).toBeTruthy();
    expect((await sync(token, ['AssetsV2'])).filter((l) => l.type === 'AssetV2' && l.data.deletedAt)).toHaveLength(0);
  });

  it('empties the trash through purge across several batches and leaves other data alone', async () => {
    const { token, ids, other } = await setupAssets(30, { second: true });
    const theirs = (await uploadAsset(other, crypto.getRandomValues(new Uint8Array(77)))).body.id;
    await call(token, 'DELETE', '/assets', { ids: ids.slice(0, 28) });
    await call(other, 'DELETE', '/assets', { ids: [theirs] });
    const res = await call(token, 'POST', '/trash/empty');
    expect(res.status).toBe(200);
    expectResponse('/trash/empty', 'post', 200, res.json);
    expect(res.json).toEqual({ count: 28 });
    expect(await count()).toBe(2 + 1);
    expect((await asset(theirs)).deleted_at).toBeTruthy();
    expect((await env.DB.prepare('SELECT count(*) AS n FROM asset_audit').first<{ n: number }>())!.n).toBe(28);
    const lines = await sync(token, ['AssetsV2']);
    expect(lines.filter((l) => l.type === 'AssetDeleteV1')).toHaveLength(28);
    expect((await call(token, 'POST', '/trash/empty')).json).toEqual({ count: 0 });
  });

  it('requires authentication', async () => {
    for (const p of ['/trash/empty', '/trash/restore', '/trash/restore/assets']) {
      const res = await SELF.fetch(`${BASE}/api${p}`, { method: 'POST', headers: { ...authHeaders('bogus'), 'content-type': 'application/json' }, body: '{}' });
      expect(res.status, p).toBe(401);
    }
  });
});

describe('timeline trash view', () => {
  it('lists trashed stills but not hidden live-photo videos', async () => {
    const { token, ids } = await setupAssets(1);
    const video = (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(60)), { filename: 'clip.mov', fields: { visibility: 'hidden' } })).body.id;
    await env.DB.prepare('UPDATE assets SET live_photo_video_id = ?2 WHERE id = ?1').bind(ids[0], video).run();
    await call(token, 'DELETE', '/assets', { ids: [ids[0]] });
    await env.DB.prepare("UPDATE assets SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1").bind(video).run();
    const buckets = await call(token, 'GET', '/timeline/buckets?isTrashed=true');
    expect(buckets.json.reduce((n: number, b: any) => n + b.count, 0)).toBe(1);
    const month = buckets.json[0].timeBucket;
    const bucket = await call(token, 'GET', `/timeline/bucket?isTrashed=true&timeBucket=${month}`);
    expect(bucket.json.id).toEqual([ids[0]]);
  });
});
