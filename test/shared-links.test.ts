import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { call, photo, twoUsers } from './album-helpers';
import { expectResponse } from './contract';
import { BASE } from './helpers';

const pub = (path: string, headers: Record<string, string> = {}) => SELF.fetch(`${BASE}/api${path}`, { headers });

async function withThumb(id: string) {
  await env.MEDIA.put(`thumbs/${id}/thumbnail.webp`, 'T');
  await env.DB.prepare('UPDATE assets SET has_thumbnail = 1 WHERE id = ?1').bind(id).run();
}

describe('shared links', () => {
  it('creates an individual link; every response carries the key, which opens the linked assets only', async () => {
    const { a, b } = await twoUsers();
    const p1 = await photo(a);
    const p2 = await photo(a, 'other.jpg');
    await withThumb(p1);
    await withThumb(p2);
    const created = await call(a, 'POST', '/shared-links', { type: 'INDIVIDUAL', assetIds: [p1], description: 'hi' });
    expect(created.status).toBe(201);
    expectResponse('/shared-links', 'post', 201, created.body);
    const key = created.body.key as string;
    expect(key).toMatch(/^[A-Za-z0-9_-]{67}$/);
    expect(created.body.assets.map((x: any) => x.id)).toEqual([p1]);
    expect(created.body).toMatchObject({ allowUpload: true, allowDownload: true, showMetadata: true, password: null, slug: null });
    const list = await call(a, 'GET', '/shared-links');
    expectResponse('/shared-links', 'get', 200, list.body);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].key).toBe(key);
    const one = await call(a, 'GET', `/shared-links/${created.body.id}`);
    expectResponse('/shared-links/{id}', 'get', 200, one.body);
    expect(one.body.key).toBe(key);
    // Immich also accepts the 100-character hex form of the same 50 bytes
    const bytes = Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/') + '='), (ch) => ch.charCodeAt(0));
    const hex = [...bytes].map((x) => x.toString(16).padStart(2, '0')).join('');
    expect(hex).toHaveLength(100);
    expect((await call(null, 'GET', `/shared-links/me?key=${hex}`)).body.key).toBe(key);
    // a key that differs in one character is refused
    const wrong = (key.startsWith('A') ? 'B' : 'A') + key.slice(1);
    expect((await call(null, 'GET', `/shared-links/me?key=${wrong}`)).status).toBe(401);
    expect((await call(b, 'GET', `/shared-links/${created.body.id}`)).status).toBe(400);
    expect((await call(b, 'GET', '/shared-links')).body).toEqual([]);

    const me = await call(null, 'GET', `/shared-links/me?key=${key}`);
    expect(me.status).toBe(200);
    expectResponse('/shared-links/me', 'get', 200, me.body);
    expect((await pub(`/assets/${p1}/thumbnail?key=${key}`)).status).toBe(200);
    expect((await pub(`/assets/${p1}/thumbnail`, { 'x-immich-share-key': key })).status).toBe(200);
    expect((await pub(`/assets/${p1}/original?key=${key}`)).status).toBe(200);
    const asset = await call(null, 'GET', `/assets/${p1}?key=${key}`);
    expectResponse('/assets/{id}', 'get', 200, asset.body);
    expect((await pub(`/assets/${p2}/thumbnail?key=${key}`)).status).toBe(404);
    expect((await pub(`/assets/${p1}/thumbnail?key=bogus`)).status).toBe(401);
    expect((await call(null, 'GET', `/timeline/buckets?key=${key}`)).status).toBe(400);
    expect((await call(null, 'GET', `/albums?key=${key}`)).status).toBe(401); // not a shared-link route

    expect((await call(a, 'DELETE', `/shared-links/${created.body.id}`)).status).toBe(204);
    expect((await pub(`/assets/${p1}/thumbnail?key=${key}`)).status).toBe(401);
  });

  it('album links open the album, its timeline and its assets', async () => {
    const { a, b, bob } = await twoUsers();
    const p = await photo(a, 'a.jpg', '2024-05-04T10:00:00.000Z');
    await withThumb(p);
    const albumId = (await call(a, 'POST', '/albums', { albumName: 'x', assetIds: [p], albumUsers: [{ userId: bob.id, role: 'viewer' }] })).body.id;
    const other = (await call(a, 'POST', '/albums', { albumName: 'y' })).body.id;
    expect((await call(b, 'POST', '/shared-links', { type: 'ALBUM', albumId })).status).toBe(400); // viewer cannot share
    const created = await call(a, 'POST', '/shared-links', { type: 'ALBUM', albumId, allowDownload: false });
    expect(created.status).toBe(201);
    expect(created.body.album.id).toBe(albumId);
    expect(created.body.album.hasSharedLink).toBe(true);
    const key = created.body.key;

    const album = await call(null, 'GET', `/albums/${albumId}?key=${key}`);
    expect(album.status).toBe(200);
    expectResponse('/albums/{id}', 'get', 200, album.body);
    expect((await call(null, 'GET', `/albums/${other}?key=${key}`)).status).toBe(400);
    const buckets = await call(null, 'GET', `/timeline/buckets?albumId=${albumId}&key=${key}`);
    expect(buckets.body).toEqual([{ timeBucket: '2024-05-01', count: 1 }]);
    expect((await pub(`/assets/${p}/thumbnail?key=${key}`)).status).toBe(200);
    expect((await pub(`/assets/${p}/original?key=${key}`)).status).toBe(400); // downloads disabled
    expect((await call(a, 'GET', `/albums/${albumId}`)).body.hasSharedLink).toBe(true);
    expect((await call(a, 'GET', `/shared-links?albumId=${albumId}`)).body).toHaveLength(1);

    await call(a, 'DELETE', `/albums/${albumId}`);
    expect((await call(a, 'GET', '/shared-links')).body).toEqual([]);
  });

  it('password links need the login cookie; the password is reported as a marker and kept on edit', async () => {
    const { a } = await twoUsers();
    const p = await photo(a);
    await withThumb(p);
    const created = (await call(a, 'POST', '/shared-links', { type: 'INDIVIDUAL', assetIds: [p], password: 'pw' })).body;
    expect(created.password).toBe('********');
    const key = created.key;
    const locked = await call(null, 'GET', `/shared-links/me?key=${key}`);
    expect(locked.status).toBe(401);
    expect(locked.body.message).toBe('Password required');
    expect((await pub(`/assets/${p}/thumbnail?key=${key}`)).status).toBe(401);
    expect((await call(null, 'POST', `/shared-links/login?key=${key}`, { password: 'wrong' })).status).toBe(401);
    const ok = await call(null, 'POST', `/shared-links/login?key=${key}`, { password: 'pw' });
    expect(ok.status).toBe(201);
    expectResponse('/shared-links/login', 'post', 201, ok.body);
    const cookie = ok.headers.get('set-cookie')!.split(';')[0];
    expect(cookie).toMatch(/^immich_shared_link_token=/);
    expect((await call(null, 'GET', `/shared-links/me?key=${key}`, undefined, { cookie })).status).toBe(200);
    expect((await pub(`/assets/${p}/thumbnail?key=${key}`, { cookie })).status).toBe(200);

    // the web edit form sends the reported value back: the password stays
    await call(a, 'PATCH', `/shared-links/${created.id}`, { password: '********', description: 'd' });
    expect((await pub(`/assets/${p}/thumbnail?key=${key}`, { cookie })).status).toBe(200);
    // a new password invalidates old cookies; clearing it opens the link
    await call(a, 'PATCH', `/shared-links/${created.id}`, { password: 'new' });
    expect((await pub(`/assets/${p}/thumbnail?key=${key}`, { cookie })).status).toBe(401);
    const cleared = await call(a, 'PATCH', `/shared-links/${created.id}`, { password: null });
    expectResponse('/shared-links/{id}', 'patch', 200, cleared.body);
    expect(cleared.body.password).toBeNull();
    expect((await pub(`/assets/${p}/thumbnail?key=${key}`)).status).toBe(200);
    expect((await call(null, 'POST', `/shared-links/login?key=${key}`, { password: 'x' })).body.message).toBe('Shared link is not password protected');
  });

  it('slugs open links, are unique, and expired links are refused', async () => {
    const { a } = await twoUsers();
    const p = await photo(a);
    const created = (await call(a, 'POST', '/shared-links', { type: 'INDIVIDUAL', assetIds: [p], slug: 'holiday' })).body;
    expect(created.slug).toBe('holiday');
    expect((await call(null, 'GET', '/shared-links/me?slug=holiday')).status).toBe(200);
    expect((await call(null, 'GET', '/shared-links/me', undefined, { 'x-immich-share-slug': 'holiday' })).status).toBe(200);
    expect((await call(null, 'GET', '/shared-links/me?slug=nope')).body.message).toBe('Invalid share slug');
    expect((await call(a, 'POST', '/shared-links', { type: 'INDIVIDUAL', assetIds: [p], slug: 'holiday' })).body.message).toBe('Failed to save shared link');
    expect((await call(null, 'GET', '/shared-links/me')).status).toBe(401);
    expect((await call(a, 'GET', '/shared-links/me')).status).toBe(403);

    await call(a, 'PATCH', `/shared-links/${created.id}`, { slug: 'holiday', expiresAt: '2020-01-01T00:00:00.000Z' });
    expect((await call(null, 'GET', '/shared-links/me?slug=holiday')).status).toBe(401);
  });

  it('adds and removes assets of individual links', async () => {
    const { a, b } = await twoUsers();
    const p1 = await photo(a);
    const p2 = await photo(a, 'x.jpg');
    const theirs = await photo(b, 'y.jpg');
    const id = (await call(a, 'POST', '/shared-links', { type: 'INDIVIDUAL', assetIds: [p1] })).body.id;
    const added = await call(a, 'PUT', `/shared-links/${id}/assets`, { assetIds: [p1, p2, theirs] });
    expectResponse('/shared-links/{id}/assets', 'put', 200, added.body);
    expect(added.body).toEqual([
      { assetId: p1, success: false, error: 'duplicate' },
      { assetId: p2, success: true },
      { assetId: theirs, success: false, error: 'no_permission' },
    ]);
    const removed = await call(a, 'DELETE', `/shared-links/${id}/assets`, { assetIds: [p1, theirs] });
    expectResponse('/shared-links/{id}/assets', 'delete', 200, removed.body);
    expect(removed.body).toEqual([
      { assetId: p1, success: true },
      { assetId: theirs, success: false, error: 'not_found' },
    ]);
    expect((await call(a, 'GET', `/shared-links/${id}`)).body.assets.map((x: any) => x.id)).toEqual([p2]);
    const albumId = (await call(a, 'POST', '/albums', { albumName: 'x' })).body.id;
    const albumLink = (await call(a, 'POST', '/shared-links', { type: 'ALBUM', albumId })).body.id;
    expect((await call(a, 'PUT', `/shared-links/${albumLink}/assets`, { assetIds: [p1] })).body.message).toBe('Invalid shared link type');
  });

  it('validates input and asset ownership', async () => {
    const { a, b } = await twoUsers();
    const theirs = await photo(b);
    expect((await call(a, 'POST', '/shared-links', {})).status).toBe(400);
    expect((await call(a, 'POST', '/shared-links', { type: 'INDIVIDUAL' })).status).toBe(400);
    expect((await call(a, 'POST', '/shared-links', { type: 'ALBUM' })).status).toBe(400);
    expect((await call(a, 'POST', '/shared-links', { type: 'INDIVIDUAL', assetIds: [theirs] })).status).toBe(400);
    expect((await call(a, 'POST', '/shared-links', { type: 'INDIVIDUAL', assetIds: ['x'] })).status).toBe(400);
    expect((await call(a, 'GET', '/shared-links/not-a-uuid')).status).toBe(400);
  });

  it('hides metadata when showMetadata is false', async () => {
    const { a } = await twoUsers();
    const p = await photo(a);
    const created = (await call(a, 'POST', '/shared-links', { type: 'INDIVIDUAL', assetIds: [p], showMetadata: false })).body;
    expect(created.allowDownload).toBe(false);
    const asset = await call(null, 'GET', `/assets/${p}?key=${created.key}`);
    expect(asset.body.hasMetadata).toBe(false);
    expect(asset.body.originalFileName).toBeUndefined();
    const me = await call(null, 'GET', `/shared-links/me?key=${created.key}`);
    expect(me.body.assets[0].originalFileName).toBeUndefined();
  });

  it('an album link without metadata hides city, country and coordinates in the timeline', async () => {
    const { a } = await twoUsers();
    const p = await photo(a);
    await env.DB.prepare(
      `INSERT INTO asset_exif (asset_id, owner_id, city, country, latitude, longitude, update_id)
       SELECT id, owner_id, 'Lyon', 'France', 45.7, 4.8, 'u' FROM assets WHERE id = ?1
       ON CONFLICT (asset_id) DO UPDATE SET city = 'Lyon', country = 'France', latitude = 45.7, longitude = 4.8`,
    )
      .bind(p)
      .run();
    const album = (await call(a, 'POST', '/albums', { albumName: 'Trip', assetIds: [p] })).body;
    const bucketFor = async (key: string) => {
      const [first] = (await call(null, 'GET', `/timeline/buckets?albumId=${album.id}&key=${key}`)).body;
      return (await call(null, 'GET', `/timeline/bucket?albumId=${album.id}&timeBucket=${first.timeBucket}&withCoordinates=true&key=${key}`)).body;
    };
    const hidden = (await call(a, 'POST', '/shared-links', { type: 'ALBUM', albumId: album.id, showMetadata: false })).body;
    const bare = await bucketFor(hidden.key);
    expect(bare.id).toEqual([p]);
    expect(bare.city).toEqual([null]);
    expect(bare.country).toEqual([null]);
    expect(bare.latitude).toBeUndefined();
    const open = (await call(a, 'POST', '/shared-links', { type: 'ALBUM', albumId: album.id })).body;
    const full = await bucketFor(open.key);
    expect(full.city).toEqual(['Lyon']);
    expect(full.latitude).toEqual([45.7]);
  });
});
