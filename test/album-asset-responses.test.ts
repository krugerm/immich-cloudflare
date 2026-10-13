import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { call, photo, twoUsers } from './album-helpers';

// Gate C4 (streams C + D): asset responses reached through albums and shared links follow Immich mapAsset with auth.
// isFavorite is `auth.user.id === ownerId && isFavorite`; mapSharedLink maps its assets without auth, so a link's
// asset list never shows isFavorite, even to the link owner.

const favorite = (id: string) => env.DB.prepare('UPDATE assets SET is_favorite = 1 WHERE id = ?1').bind(id).run();

describe('album and shared-link asset responses', () => {
  it('album members see another owner’s favorite as isFavorite false; the owner sees true', async () => {
    const { a, b, bob } = await twoUsers();
    const p = await photo(a, 'p.jpg', '2024-05-04T10:00:00.000Z');
    await favorite(p);
    const albumId = (await call(a, 'POST', '/albums', { albumName: 'x', assetIds: [p], albumUsers: [{ userId: bob.id, role: 'viewer' }] })).body.id;

    expect((await call(a, 'GET', `/assets/${p}`)).body.isFavorite).toBe(true);
    const asMember = await call(b, 'GET', `/assets/${p}`);
    expect(asMember.status).toBe(200);
    expect(asMember.body.isFavorite).toBe(false);
    expect((await call(b, 'GET', `/timeline/bucket?albumId=${albumId}&timeBucket=2024-05-01`)).body.isFavorite).toEqual([false]);
    expect((await call(a, 'GET', `/timeline/bucket?albumId=${albumId}&timeBucket=2024-05-01`)).body.isFavorite).toEqual([true]);
  });

  it('shared-link asset lists never report isFavorite; a link without metadata gets the sanitized shape', async () => {
    const { a } = await twoUsers();
    const p = await photo(a);
    await favorite(p);
    const link = (await call(a, 'POST', '/shared-links', { type: 'INDIVIDUAL', assetIds: [p] })).body;
    expect(link.assets.map((x: any) => x.isFavorite)).toEqual([false]);
    const listed = (await call(a, 'GET', '/shared-links')).body.find((l: any) => l.id === link.id);
    expect(listed.assets.map((x: any) => x.isFavorite)).toEqual([false]);
    expect((await call(null, 'GET', `/shared-links/me?key=${link.key}`)).body.assets.map((x: any) => x.isFavorite)).toEqual([false]);

    const bare = (await call(a, 'POST', '/shared-links', { type: 'INDIVIDUAL', assetIds: [p], showMetadata: false })).body;
    const asset = (await call(null, 'GET', `/shared-links/me?key=${bare.key}`)).body.assets[0];
    expect(asset.hasMetadata).toBe(false);
    for (const field of ['isFavorite', 'originalFileName', 'originalPath', 'checksum', 'exifInfo', 'ownerId']) expect(asset).not.toHaveProperty(field);
  });
});
