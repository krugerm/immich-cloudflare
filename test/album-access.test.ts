import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { canReadAsset } from '../src/access/assets';
import { expectResponse } from './contract';
import { authHeaders, BASE } from './helpers';
import { call, photo, twoUsers } from './album-helpers';

const fetchAs = (token: string, path: string) => SELF.fetch(`${BASE}/api${path}`, { headers: authHeaders(token) });

describe('album access to assets', () => {
  it('album members read assets of others; strangers and removed members do not', async () => {
    const { a, b, c, bob } = await twoUsers();
    const p = await photo(a);
    await env.MEDIA.put(`thumbs/${p}/thumbnail.webp`, 'T');
    await env.DB.prepare('UPDATE assets SET has_thumbnail = 1, is_favorite = 1 WHERE id = ?1').bind(p).run();
    const id = (await call(a, 'POST', '/albums', { albumName: 'x', assetIds: [p], albumUsers: [{ userId: bob.id, role: 'viewer' }] })).body.id;

    expect((await fetchAs(b, `/assets/${p}/thumbnail`)).status).toBe(200);
    expect((await fetchAs(b, `/assets/${p}/original`)).status).toBe(200);
    const info = await call(b, 'GET', `/assets/${p}`);
    expect(info.status).toBe(200);
    expectResponse('/assets/{id}', 'get', 200, info.body);
    expect(info.body.isFavorite).toBe(false); // only the owner sees their favourite flag
    expect((await call(a, 'GET', `/assets/${p}`)).body.isFavorite).toBe(true);
    expect((await fetchAs(c, `/assets/${p}/thumbnail`)).status).toBe(404);

    await call(a, 'DELETE', `/albums/${id}/user/${bob.id}`);
    expect((await fetchAs(b, `/assets/${p}/thumbnail`)).status).toBe(404);
  });

  it('a trashed album asset is not readable by members; a live-photo video of an album still is', async () => {
    const { a, bob } = await twoUsers();
    const still = await photo(a);
    const video = await photo(a, 'v.mov');
    const trashed = await photo(a, 't.jpg');
    await env.DB.prepare('UPDATE assets SET live_photo_video_id = ?1 WHERE id = ?2').bind(video, still).run();
    await env.DB.prepare("UPDATE assets SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1").bind(trashed).run();
    await call(a, 'POST', '/albums', { albumName: 'x', assetIds: [still, trashed], albumUsers: [{ userId: bob.id, role: 'viewer' }] });
    expect(await canReadAsset(env.DB, bob.id, still)).toBe(true);
    expect(await canReadAsset(env.DB, bob.id, video)).toBe(true);
    expect(await canReadAsset(env.DB, bob.id, trashed)).toBe(false);
  });

  it('timeline albumId returns the album assets of every owner to members only', async () => {
    const { a, b, c, bob } = await twoUsers();
    const pa = await photo(a, 'a.jpg', '2024-05-04T10:00:00.000Z');
    const pb = await photo(b, 'b.jpg', '2024-05-10T10:00:00.000Z');
    await photo(a, 'outside.jpg', '2024-05-11T10:00:00.000Z');
    const id = (await call(a, 'POST', '/albums', { albumName: 'x', assetIds: [pa], albumUsers: [{ userId: bob.id, role: 'editor' }] })).body.id;
    await call(b, 'PUT', `/albums/${id}/assets`, { ids: [pb] });

    const buckets = await call(b, 'GET', `/timeline/buckets?albumId=${id}`);
    expectResponse('/timeline/buckets', 'get', 200, buckets.body);
    expect(buckets.body).toEqual([{ timeBucket: '2024-05-01', count: 2 }]);
    const bucket = await call(a, 'GET', `/timeline/bucket?albumId=${id}&timeBucket=2024-05-01`);
    expectResponse('/timeline/bucket', 'get', 200, bucket.body);
    expect(bucket.body.id.sort()).toEqual([pa, pb].sort());
    expect((await call(c, 'GET', `/timeline/buckets?albumId=${id}`)).status).toBe(400);
  });
});
