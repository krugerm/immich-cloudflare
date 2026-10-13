import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { call, photo, twoUsers } from './album-helpers';
import { authHeaders, BASE } from './helpers';

// Gate C1 (streams B + C): moving assets into the locked folder removes them from every album
// (Immich AssetService.updateAll → AlbumRepository.removeAssetsFromAll), in the same commit batch as the update.

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

async function elevate(token: string) {
  expect((await call(token, 'POST', '/auth/pin-code', { pinCode: '123456' })).status).toBe(204);
  expect((await call(token, 'POST', '/auth/session/unlock', { pinCode: '123456' })).status).toBe(204);
}

async function setup() {
  const { a, b, bob } = await twoUsers();
  const p = await photo(a, 'p.jpg', '2024-05-04T10:00:00.000Z');
  const q = await photo(a, 'q.jpg', '2024-01-01T10:00:00.000Z');
  const x = (await call(a, 'POST', '/albums', { albumName: 'x', assetIds: [p, q], albumUsers: [{ userId: bob.id, role: 'viewer' }] })).body.id;
  const y = (await call(a, 'POST', '/albums', { albumName: 'y', assetIds: [p] })).body.id;
  expect((await call(a, 'GET', `/albums/${x}`)).body.albumThumbnailAssetId).toBe(p);
  await syncAndAck(b);
  await elevate(a);
  return { a, b, p, q, x, y };
}

async function expectRemoved(ctx: Awaited<ReturnType<typeof setup>>) {
  const { a, b, p, q, x, y } = ctx;
  const { results } = await env.DB.prepare('SELECT album_id FROM album_assets WHERE asset_id = ?1').bind(p).all();
  expect(results).toEqual([]);
  const info = (await call(b, 'GET', `/albums/${x}`)).body;
  expect(info.assetCount).toBe(1);
  expect(info.albumThumbnailAssetId).toBe(q);
  expect((await call(a, 'GET', `/albums/${y}`)).body.assetCount).toBe(0);
  const lines = await sync(b);
  const deletes = lines.filter((l) => l.type === 'AlbumToAssetDeleteV1');
  expect(deletes.map((l) => l.data)).toEqual([{ albumId: x, assetId: p }]);
  expect(lines.some((l) => l.type === 'AlbumV2' && l.data.id === x && l.data.thumbnailAssetId === q)).toBe(true);
}

describe('locking an asset removes it from albums', () => {
  it('PUT /assets/:id visibility=locked', async () => {
    const ctx = await setup();
    expect((await call(ctx.a, 'PUT', `/assets/${ctx.p}`, { visibility: 'locked' })).status).toBe(200);
    await expectRemoved(ctx);
  });

  it('PUT /assets (bulk) visibility=locked', async () => {
    const ctx = await setup();
    expect((await call(ctx.a, 'PUT', '/assets', { ids: [ctx.p], visibility: 'locked' })).status).toBe(204);
    await expectRemoved(ctx);
  });

  it('other visibility changes keep album membership', async () => {
    const { a, p, x } = await setup();
    expect((await call(a, 'PUT', '/assets', { ids: [p], visibility: 'archive' })).status).toBe(204);
    expect((await call(a, 'GET', `/albums/${x}`)).body.assetCount).toBe(2);
  });
});
