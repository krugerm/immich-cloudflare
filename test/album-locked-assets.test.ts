import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { removeAssetFromAllAlbums } from '../src/albums/repo';
import { commit } from '../src/db/changes';
import { call, photo, twoUsers } from './album-helpers';
import { expectSchema } from './contract';
import { authHeaders, BASE } from './helpers';

const lock = (id: string) => env.DB.prepare("UPDATE assets SET visibility = 'locked' WHERE id = ?1").bind(id).run();
const pub = (path: string) => SELF.fetch(`${BASE}/api${path}`);

async function elevate(token: string) {
  expect((await call(token, 'POST', '/auth/pin-code', { pinCode: '123456' })).status).toBe(204);
  expect((await call(token, 'POST', '/auth/session/unlock', { pinCode: '123456' })).status).toBe(204);
}

async function withThumb(id: string) {
  await env.MEDIA.put(`thumbs/${id}/thumbnail.webp`, 'T');
  await env.DB.prepare('UPDATE assets SET has_thumbnail = 1 WHERE id = ?1').bind(id).run();
}

describe('locked assets in albums and shared links', () => {
  it('cannot be shared: album adds report no_permission, individual links are refused', async () => {
    const { a } = await twoUsers();
    const p = await photo(a);
    await lock(p);
    const albumId = (await call(a, 'POST', '/albums', { albumName: 'x', assetIds: [p] })).body.id;
    expect((await call(a, 'GET', `/albums/${albumId}`)).body.assetCount).toBe(0);
    // Immich bulk add answers 200 with a per-asset error (requireAccess would be 400 only for a single-id call)
    expect((await call(a, 'PUT', `/albums/${albumId}/assets`, { ids: [p] })).body).toEqual([{ id: p, success: false, error: 'no_permission' }]);
    expect((await call(a, 'PUT', '/albums/assets', { albumIds: [albumId], assetIds: [p] })).body).toEqual({ success: false, error: 'no_permission' });
    const link = await call(a, 'POST', '/shared-links', { type: 'INDIVIDUAL', assetIds: [p] });
    expect(link.status).toBe(400);
    expect(link.body.message).toBe('Not found or no asset.share access');
  });

  it('a link row pointing at a locked asset opens nothing for an anonymous holder', async () => {
    const { a } = await twoUsers();
    const p = await photo(a);
    await withThumb(p);
    const link = (await call(a, 'POST', '/shared-links', { type: 'INDIVIDUAL', assetIds: [p] })).body;
    const albumId = (await call(a, 'POST', '/albums', { albumName: 'x', assetIds: [p] })).body.id;
    const albumLink = (await call(a, 'POST', '/shared-links', { type: 'ALBUM', albumId })).body;
    expect((await pub(`/assets/${p}/thumbnail?key=${link.key}`)).status).toBe(200);
    await lock(p);
    for (const key of [link.key, albumLink.key]) {
      expect((await pub(`/assets/${p}/thumbnail?key=${key}`)).status).toBe(404);
      expect((await pub(`/assets/${p}/original?key=${key}`)).status).toBe(404);
      expect((await pub(`/assets/${p}?key=${key}`)).status).toBe(404);
    }
    expect((await call(null, 'GET', `/shared-links/me?key=${link.key}`)).body.assets).toEqual([]);
    expect((await call(null, 'GET', `/timeline/buckets?albumId=${albumId}&key=${albumLink.key}`)).body).toEqual([]);
    // Immich timeBucketChecks: requireElevatedPermission, which a shared link never has
    expect((await call(null, 'GET', `/timeline/buckets?albumId=${albumId}&visibility=locked&key=${albumLink.key}`)).status).toBe(401);
  });

  it('album timelines show locked assets only to their owner; isFavorite is the viewer’s own', async () => {
    const { a, b, bob } = await twoUsers();
    const p = await photo(a, 'p.jpg', '2024-05-04T10:00:00.000Z');
    const fav = await photo(a, 'f.jpg', '2024-05-05T10:00:00.000Z');
    await env.DB.prepare('UPDATE assets SET is_favorite = 1 WHERE id = ?1').bind(fav).run();
    const albumId = (await call(a, 'POST', '/albums', { albumName: 'x', assetIds: [p, fav], albumUsers: [{ userId: bob.id, role: 'viewer' }] })).body.id;
    await lock(p); // left in the album, as if locked before the merge-time removal existed

    expect((await call(b, 'GET', `/timeline/buckets?albumId=${albumId}`)).body).toEqual([{ timeBucket: '2024-05-01', count: 1 }]);
    expect((await call(b, 'GET', `/timeline/buckets?albumId=${albumId}&isTrashed=true`)).body).toEqual([]);
    // the locked timeline needs a PIN-elevated session (G2); elevated, only the owner's own locked asset is listed
    expect((await call(b, 'GET', `/timeline/buckets?albumId=${albumId}&visibility=locked`)).status).toBe(401);
    expect((await call(a, 'GET', `/timeline/buckets?albumId=${albumId}&visibility=locked`)).status).toBe(401);
    await elevate(b);
    await elevate(a);
    expect((await call(b, 'GET', `/timeline/buckets?albumId=${albumId}&visibility=locked`)).body).toEqual([]);
    expect((await call(a, 'GET', `/timeline/buckets?albumId=${albumId}&visibility=locked`)).body).toEqual([{ timeBucket: '2024-05-01', count: 1 }]);

    const bucket = (await call(b, 'GET', `/timeline/bucket?albumId=${albumId}&timeBucket=2024-05-01`)).body;
    expect(bucket.id).toEqual([fav]);
    expect(bucket.isFavorite).toEqual([false]);
    expect((await call(a, 'GET', `/timeline/bucket?albumId=${albumId}&timeBucket=2024-05-01`)).body.isFavorite).toEqual([true]);
  });

  it('map markers, thumbnails and activities skip locked album assets', async () => {
    const { a, b, admin, bob } = await twoUsers();
    const p = await photo(a, 'p.jpg', '2024-05-04T10:00:00.000Z');
    const q = await photo(a, 'q.jpg', '2024-01-01T10:00:00.000Z');
    for (const id of [p, q]) {
      await env.DB.prepare("INSERT INTO asset_exif (asset_id, owner_id, latitude, longitude, update_id) VALUES (?1, ?2, 1, 2, 'x')").bind(id, admin.id).run();
    }
    const albumId = (await call(a, 'POST', '/albums', { albumName: 'x', assetIds: [p, q], albumUsers: [{ userId: bob.id, role: 'viewer' }] })).body.id;
    await call(b, 'POST', '/activities', { albumId, assetId: p, type: 'like' });
    await lock(p);
    expect((await call(b, 'GET', `/albums/${albumId}/map-markers`)).body.map((m: any) => m.id)).toEqual([q]);
    expect((await call(b, 'GET', `/albums/${albumId}`)).body.albumThumbnailAssetId).toBe(q);
    expect((await call(b, 'GET', `/activities?albumId=${albumId}`)).body).toEqual([]);
  });

  it('removeAssetFromAllAlbums removes the asset from every album with audited deletes', async () => {
    const { a, b, admin, bob } = await twoUsers();
    const p = await photo(a, 'p.jpg', '2024-05-04T10:00:00.000Z');
    const q = await photo(a, 'q.jpg', '2024-01-01T10:00:00.000Z');
    const x = (await call(a, 'POST', '/albums', { albumName: 'x', assetIds: [p, q], albumUsers: [{ userId: bob.id, role: 'viewer' }] })).body.id;
    const y = (await call(a, 'POST', '/albums', { albumName: 'y', assetIds: [p] })).body.id;
    const sync = async () => {
      const res = await SELF.fetch(`${BASE}/api/sync/stream`, {
        method: 'POST',
        headers: { ...authHeaders(b), 'content-type': 'application/json' },
        body: JSON.stringify({ types: ['AlbumsV2', 'AlbumToAssetsV1'] }),
      });
      return (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    };
    const first = await sync();
    await call(b, 'POST', '/sync/ack', { acks: first.filter((l: any) => l.type !== 'SyncCompleteV1').map((l: any) => l.ack) });

    expect(await removeAssetFromAllAlbums(env.DB, bob.id, p)).toEqual([]); // not the owner
    await lock(p);
    await commit(env.DB, await removeAssetFromAllAlbums(env.DB, admin.id, p));

    const { results } = await env.DB.prepare('SELECT album_id FROM album_assets WHERE asset_id = ?1').bind(p).all();
    expect(results).toEqual([]);
    const audits = await env.DB.prepare('SELECT album_id FROM album_asset_audit WHERE asset_id = ?1 ORDER BY album_id').bind(p).all<{ album_id: string }>();
    expect(audits.results.map((r) => r.album_id)).toEqual([x, y].sort());
    expect((await call(a, 'GET', `/albums/${x}`)).body.albumThumbnailAssetId).toBe(q);
    expect((await call(a, 'GET', `/albums/${y}`)).body.albumThumbnailAssetId).toBeNull();

    const lines = await sync();
    expect(lines.map((l: any) => l.type)).toEqual(['AlbumV2', 'AlbumToAssetDeleteV1', 'SyncCompleteV1']);
    expect(lines[0].data.thumbnailAssetId).toBe(q);
    expectSchema('SyncAlbumToAssetDeleteV1', lines[1].data);
    expect(lines[1].data).toEqual({ albumId: x, assetId: p });
  });
});
