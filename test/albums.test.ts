import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { call, photo, twoUsers } from './album-helpers';
import { expectResponse } from './contract';
import { createUser, login } from './helpers';

describe('albums', () => {
  it('creates an album with assets and members, owner first', async () => {
    const { a, bob } = await twoUsers();
    const p1 = await photo(a, 'a.jpg', '2024-05-04T10:00:00.000Z');
    const p2 = await photo(a, 'b.jpg', '2024-06-01T10:00:00.000Z');
    const res = await call(a, 'POST', '/albums', {
      albumName: 'Trip',
      description: '',
      assetIds: [p1, p2],
      albumUsers: [{ userId: bob.id, role: 'viewer' }],
    });
    expect(res.status).toBe(201);
    expectResponse('/albums', 'post', 201, res.body);
    expect(res.body.albumName).toBe('Trip');
    expect(res.body.description).toBe('');
    expect(res.body.assetCount).toBe(2);
    expect(res.body.albumThumbnailAssetId).toBe(p1);
    expect(res.body.albumUsers.map((u: any) => [u.user.email, u.role])).toEqual([
      ['admin@example.com', 'owner'],
      ['bob@example.com', 'viewer'],
    ]);
    expect(res.body.shared).toBe(true);
    expect(res.body.startDate).toBe('2024-05-04T00:00:00.000Z');
    expect(res.body.endDate).toBe('2024-06-01T00:00:00.000Z');
    expect(res.body.order).toBe('desc');
  });

  it('rejects bad input with 400', async () => {
    const { a } = await twoUsers();
    expect((await call(a, 'POST', '/albums', {})).status).toBe(400);
    expect((await call(a, 'POST', '/albums', { albumName: 'x', assetIds: ['nope'] })).status).toBe(400);
    expect((await call(a, 'POST', '/albums', { albumName: 'x', albumUsers: [{ userId: crypto.randomUUID(), role: 'viewer' }] })).body.message).toBe('Invalid user');
    expect((await call(a, 'GET', '/albums/not-a-uuid')).status).toBe(400);
    expect((await call(a, 'GET', '/albums?isOwned=maybe')).status).toBe(400);
    const id = (await call(a, 'POST', '/albums', { albumName: 'x' })).body.id;
    expect((await call(a, 'PATCH', `/albums/${id}`, { order: 'sideways' })).status).toBe(400);
    expect((await call(a, 'PUT', `/albums/${id}/assets`, { ids: 'x' })).status).toBe(400);
  });

  it('assets of others are not added (no_permission), duplicates are reported', async () => {
    const { a, b } = await twoUsers();
    const mine = await photo(a);
    const theirs = await photo(b, 'b.jpg');
    const created = await call(a, 'POST', '/albums', { albumName: 'x', assetIds: [theirs] });
    expect(created.body.assetCount).toBe(0);
    const id = created.body.id;
    const res = await call(a, 'PUT', `/albums/${id}/assets`, { ids: [mine, theirs, mine] });
    expect(res.status).toBe(200);
    expectResponse('/albums/{id}/assets', 'put', 200, res.body);
    expect(res.body).toEqual([
      { id: mine, success: true },
      { id: theirs, success: false, error: 'no_permission' },
      { id: mine, success: false, error: 'duplicate' },
    ]);
    const info = await call(a, 'GET', `/albums/${id}`);
    expectResponse('/albums/{id}', 'get', 200, info.body);
    expect(info.body.assetCount).toBe(1);
    expect(info.body.albumThumbnailAssetId).toBe(mine);
  });

  it('lists with filters and statistics', async () => {
    const { a, b, bob } = await twoUsers();
    const own = (await call(a, 'POST', '/albums', { albumName: 'solo' })).body.id;
    const sharedOut = (await call(a, 'POST', '/albums', { albumName: 'out', albumUsers: [{ userId: bob.id, role: 'editor' }] })).body.id;
    const p = await photo(b);
    const sharedIn = (await call(b, 'POST', '/albums', { albumName: 'in', assetIds: [p] })).body.id;
    const admin = (await call(b, 'GET', '/users/me')).body;
    expect(admin.id).toBe(bob.id);
    const adminId = (await call(a, 'GET', '/users/me')).body.id;
    await call(b, 'PUT', `/albums/${sharedIn}/users`, { albumUsers: [{ userId: adminId }] });

    const all = await call(a, 'GET', '/albums');
    expectResponse('/albums', 'get', 200, all.body);
    expect(all.body.map((x: any) => x.albumName).sort()).toEqual(['in', 'out', 'solo']);
    const ids = async (q: string) => (await call(a, 'GET', `/albums${q}`)).body.map((x: any) => x.id).sort();
    expect(await ids('?isOwned=true')).toEqual([own, sharedOut].sort());
    expect(await ids('?isOwned=false')).toEqual([sharedIn]);
    expect(await ids('?isShared=true')).toEqual([sharedIn, sharedOut].sort());
    expect(await ids('?isShared=false')).toEqual([own]);
    expect(await ids('?name=solo')).toEqual([own]);
    expect(await ids(`?assetId=${p}`)).toEqual([sharedIn]);

    const stats = await call(a, 'GET', '/albums/statistics');
    expectResponse('/albums/statistics', 'get', 200, stats.body);
    expect(stats.body).toEqual({ owned: 2, shared: 2, notShared: 1 });
  });

  it('enforces roles: non-member, viewer, editor, owner', async () => {
    const { a, b, c, bob, carol } = await twoUsers();
    const pa = await photo(a);
    const pb = await photo(b, 'b.jpg');
    const id = (
      await call(a, 'POST', '/albums', {
        albumName: 'x',
        assetIds: [pa],
        albumUsers: [
          { userId: bob.id, role: 'editor' },
          { userId: carol.id, role: 'viewer' },
        ],
      })
    ).body.id;
    const stranger = await createUser({ email: 'd@example.com', isAdmin: false });
    const d = await login('d@example.com');
    expect(stranger.id).toBeTruthy();

    const denied = await call(d, 'GET', `/albums/${id}`);
    expect(denied.status).toBe(400);
    expect(denied.body.message).toBe('Not found or no album.read access');
    expect((await call(c, 'GET', `/albums/${id}`)).status).toBe(200);
    expect((await call(c, 'PUT', `/albums/${id}/assets`, { ids: [pb] })).status).toBe(400);
    expect((await call(c, 'PATCH', `/albums/${id}`, { albumName: 'y' })).status).toBe(400);

    // editor adds own asset, renames, but cannot delete the album or remove the owner's asset
    expect((await call(b, 'PUT', `/albums/${id}/assets`, { ids: [pb] })).body).toEqual([{ id: pb, success: true }]);
    expect((await call(b, 'PATCH', `/albums/${id}`, { albumName: 'renamed', description: 'd' })).body.albumName).toBe('renamed');
    expect((await call(b, 'DELETE', `/albums/${id}`)).status).toBe(400);
    expect((await call(b, 'DELETE', `/albums/${id}/assets`, { ids: [pa, pb] })).body).toEqual([
      { id: pa, success: false, error: 'no_permission' },
      { id: pb, success: true },
    ]);
    // owner removes anything
    expect((await call(a, 'DELETE', `/albums/${id}/assets`, { ids: [pa, pb] })).body).toEqual([
      { id: pa, success: true },
      { id: pb, success: false, error: 'not_found' },
    ]);
    const info = (await call(a, 'GET', `/albums/${id}`)).body;
    expect(info.assetCount).toBe(0);
    expect(info.albumThumbnailAssetId).toBeNull();
    expect((await call(a, 'DELETE', `/albums/${id}`)).status).toBe(204);
    expect((await call(a, 'GET', `/albums/${id}`)).status).toBe(400);
  });

  it('manages members: add, change role, leave, remove; owner is protected', async () => {
    const { a, b, c, admin, bob, carol } = await twoUsers();
    const id = (await call(a, 'POST', '/albums', { albumName: 'x' })).body.id;
    const added = await call(a, 'PUT', `/albums/${id}/users`, { albumUsers: [{ userId: bob.id, role: 'viewer' }, { userId: carol.id }] });
    expect(added.status).toBe(200);
    expectResponse('/albums/{id}/users', 'put', 200, added.body);
    expect(added.body.albumUsers.map((u: any) => u.role)).toEqual(['owner', 'editor', 'viewer']);
    expect((await call(a, 'PUT', `/albums/${id}/users`, { albumUsers: [{ userId: bob.id, role: 'owner' }] })).body.message).toBe('Cannot add another owner');
    expect((await call(b, 'PUT', `/albums/${id}/users`, { albumUsers: [{ userId: carol.id }] })).status).toBe(400); // viewer cannot share

    expect((await call(a, 'PUT', `/albums/${id}/user/${bob.id}`, { role: 'editor' })).status).toBe(204);
    expect((await call(a, 'PUT', `/albums/${id}/user/${admin.id}`, { role: 'viewer' })).body.message).toBe('User is owner');
    expect((await call(a, 'PUT', `/albums/${id}/user/${bob.id}`, { role: 'boss' })).status).toBe(400);

    expect((await call(c, 'DELETE', `/albums/${id}/user/me`)).status).toBe(204);
    expect((await call(c, 'GET', `/albums/${id}`)).status).toBe(400);
    expect((await call(a, 'DELETE', `/albums/${id}/user/${admin.id}`)).body.message).toBe('Cannot remove the last album owner');
    expect((await call(a, 'DELETE', `/albums/${id}/user/${carol.id}`)).body.message).toBe('Album not shared with user');
    expect((await call(a, 'DELETE', `/albums/${id}/user/${bob.id}`)).status).toBe(204);
    const info = (await call(a, 'GET', `/albums/${id}`)).body;
    expect(info.albumUsers).toHaveLength(1);
    expect(info.shared).toBe(false);
  });

  it('adds assets to several albums at once', async () => {
    const { a } = await twoUsers();
    const p1 = await photo(a);
    const x = (await call(a, 'POST', '/albums', { albumName: 'x' })).body.id;
    const y = (await call(a, 'POST', '/albums', { albumName: 'y', assetIds: [p1] })).body.id;
    const res = await call(a, 'PUT', '/albums/assets', { albumIds: [x, y], assetIds: [p1] });
    expectResponse('/albums/assets', 'put', 200, res.body);
    expect(res.body).toEqual({ success: true });
    expect((await call(a, 'PUT', '/albums/assets', { albumIds: [x, y], assetIds: [p1] })).body).toEqual({ success: false, error: 'duplicate' });
    expect((await call(a, 'PUT', '/albums/assets', { albumIds: [crypto.randomUUID()], assetIds: [p1] })).body).toEqual({ success: false, error: 'no_permission' });
    expect((await call(a, 'GET', `/albums/${x}`)).body.assetCount).toBe(1);
  });

  it('updates album fields and validates the thumbnail', async () => {
    const { a } = await twoUsers();
    const p1 = await photo(a);
    const p2 = await photo(a, 'z.jpg');
    const id = (await call(a, 'POST', '/albums', { albumName: 'x', assetIds: [p1] })).body.id;
    expect((await call(a, 'PATCH', `/albums/${id}`, { albumThumbnailAssetId: p2 })).body.message).toBe('Invalid album thumbnail');
    const res = await call(a, 'PATCH', `/albums/${id}`, { albumName: 'n', description: 'about', isActivityEnabled: false, order: 'asc' });
    expectResponse('/albums/{id}', 'patch', 200, res.body);
    expect(res.body).toMatchObject({ albumName: 'n', description: 'about', isActivityEnabled: false, order: 'asc' });
  });

  it('serves map markers from album assets with coordinates', async () => {
    const { a } = await twoUsers();
    const p1 = await photo(a);
    await env.DB.prepare("INSERT INTO asset_exif (asset_id, owner_id, latitude, longitude, city, update_id) VALUES (?1, ?2, 46.5, 6.6, 'Lausanne', 'x')")
      .bind(p1, (await call(a, 'GET', '/users/me')).body.id)
      .run();
    const id = (await call(a, 'POST', '/albums', { albumName: 'x', assetIds: [p1] })).body.id;
    const res = await call(a, 'GET', `/albums/${id}/map-markers`);
    expectResponse('/albums/{id}/map-markers', 'get', 200, res.body);
    expect(res.body).toEqual([{ id: p1, lat: 46.5, lon: 6.6, city: 'Lausanne', state: null, country: null }]);
  });

  it('repairs the thumbnail when its asset is trashed', async () => {
    const { a } = await twoUsers();
    const p1 = await photo(a, 'a.jpg', '2024-01-01T00:00:00.000Z');
    const p2 = await photo(a, 'b.jpg', '2024-02-01T00:00:00.000Z');
    const id = (await call(a, 'POST', '/albums', { albumName: 'x', assetIds: [p1, p2] })).body.id;
    await env.DB.prepare("UPDATE assets SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1").bind(p1).run();
    expect((await call(a, 'GET', '/albums')).body[0].albumThumbnailAssetId).toBe(p2);
  });
});
