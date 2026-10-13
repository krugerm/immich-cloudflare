import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { purgeDeletedUsers } from '../src/cron/purge-users';
import { purgeAssets, purgeTrash } from '../src/cron/purge';
import type { AssetRow } from '../src/db/rows';
import { call, photo, twoUsers } from './album-helpers';
import { authHeaders, BASE } from './helpers';

// Final review item 1: hard-deleting assets removes them from albums with an audit row per album
// (members get AlbumToAssetDeleteV1) and moves the album thumbnail off them.

type Line = { type: string; data: Record<string, any>; ack: string };

async function sync(token: string): Promise<Line[]> {
  const res = await SELF.fetch(`${BASE}/api/sync/stream`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify({ types: ['AlbumsV2', 'AlbumToAssetsV1'] }),
  });
  return (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function syncAndAck(token: string): Promise<Line[]> {
  const lines = await sync(token);
  const acks = lines.filter((l) => l.type !== 'SyncCompleteV1').map((l) => l.ack);
  expect((await call(token, 'POST', '/sync/ack', { acks })).status).toBe(204);
  return lines;
}

const thumbOf = (albumId: string) => env.DB.prepare('SELECT thumbnail_asset_id FROM albums WHERE id = ?1').bind(albumId).first<string | null>('thumbnail_asset_id');

/** Admin owns p (newest, the thumbnail) and q in album x shared with Bob. */
async function setup() {
  const users = await twoUsers();
  const { a, b, bob } = users;
  const p = await photo(a, 'p.jpg', '2024-05-04T10:00:00.000Z');
  const q = await photo(a, 'q.jpg', '2024-01-01T10:00:00.000Z');
  const x = (await call(a, 'POST', '/albums', { albumName: 'x', assetIds: [p, q], albumUsers: [{ userId: bob.id, role: 'editor' }] })).body.id;
  expect((await call(a, 'GET', `/albums/${x}`)).body.albumThumbnailAssetId).toBe(p);
  await syncAndAck(b);
  return { ...users, p, q, x };
}

async function expectPurgedFromAlbum(memberToken: string, x: string, gone: string, left: string) {
  expect(await env.DB.prepare('SELECT 1 FROM assets WHERE id = ?1').bind(gone).first()).toBeNull();
  expect(await thumbOf(x)).toBe(left);
  const lines = await sync(memberToken);
  expect(lines.filter((l) => l.type === 'AlbumToAssetDeleteV1').map((l) => l.data)).toEqual([{ albumId: x, assetId: gone }]);
  expect(lines.some((l) => l.type === 'AlbumV2' && l.data.id === x && l.data.thumbnailAssetId === left)).toBe(true);
}

describe('asset hard deletes leave albums consistent', () => {
  it('trash empty', async () => {
    const { a, b, p, q, x } = await setup();
    expect((await call(a, 'DELETE', '/assets', { ids: [p] })).status).toBe(204);
    expect((await call(a, 'POST', '/trash/empty')).body.count).toBe(1);
    await expectPurgedFromAlbum(b, x, p, q);
  });

  it('force delete', async () => {
    const { a, b, p, q, x } = await setup();
    expect((await call(a, 'DELETE', '/assets', { ids: [p], force: true })).status).toBe(204);
    await expectPurgedFromAlbum(b, x, p, q);
  });

  it('the 30-day trash purge', async () => {
    const { b, p, q, x } = await setup();
    await env.DB.prepare("UPDATE assets SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1").bind(p).run();
    expect(await purgeTrash(env, new Date('2026-03-15T00:00:00.000Z'))).toBe(1);
    await expectPurgedFromAlbum(b, x, p, q);
  });

  it('a purge that a restore overtook leaves the album alone', async () => {
    const { b, p, x } = await setup();
    const row = (await env.DB.prepare('SELECT * FROM assets WHERE id = ?1').bind(p).first<AssetRow>())!;
    // Selected as trashed, but restored (deleted_at NULL) before the commit: the guarded statements skip it.
    await purgeAssets(env, [{ ...row, deleted_at: '2026-01-01T00:00:00.000Z' }], new Date());
    expect(await env.DB.prepare('SELECT 1 FROM album_assets WHERE album_id = ?1 AND asset_id = ?2').bind(x, p).first()).not.toBeNull();
    expect(await thumbOf(x)).toBe(p);
    expect((await sync(b)).filter((l) => l.type === 'AlbumToAssetDeleteV1')).toEqual([]);
  });

  it('user purge', async () => {
    const { a, b, bob, p, x } = await setup();
    // Bob's newest photo becomes the album thumbnail.
    const r = await photo(b, 'r.jpg', '2025-01-01T10:00:00.000Z');
    expect((await call(b, 'PUT', `/albums/${x}/assets`, { ids: [r] })).status).toBe(200);
    await env.DB.prepare('UPDATE albums SET thumbnail_asset_id = ?2 WHERE id = ?1').bind(x, r).run();
    await syncAndAck(a);
    expect((await call(a, 'DELETE', `/admin/users/${bob.id}`, { force: true })).status).toBe(200);
    await purgeDeletedUsers(env);
    expect(await env.DB.prepare('SELECT 1 FROM users WHERE id = ?1').bind(bob.id).first()).toBeNull();
    await expectPurgedFromAlbum(a, x, r, p);
  });
});
