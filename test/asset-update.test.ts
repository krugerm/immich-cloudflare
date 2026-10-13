import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { processAsset } from '../src/process/consumer';
import type { Thumbnailer } from '../src/process/thumbs';
import { encode } from 'fast-png';
import { expectResponse, expectSchema } from './contract';
import { call, setupAssets, sync } from './stream-b';
import sampleJpg from './fixtures/media/sample.jpg?arraybuffer';
import { uploadAsset } from './helpers';

const asset = (id: string) => env.DB.prepare('SELECT * FROM assets WHERE id = ?1').bind(id).first<any>();
const exif = (id: string) => env.DB.prepare('SELECT * FROM asset_exif WHERE asset_id = ?1').bind(id).first<any>();

describe('PUT /assets/{id}', () => {
  it('updates favorite, visibility and exif fields and returns the asset', async () => {
    const { token, ids } = await setupAssets();
    const before = await asset(ids[0]);
    const res = await call(token, 'PUT', `/assets/${ids[0]}`, {
      isFavorite: true,
      visibility: 'archive',
      description: 'On the beach',
      latitude: 47.37,
      longitude: 8.54,
      rating: 4,
      dateTimeOriginal: '2023-07-01T12:30:00.000+02:00',
    });
    expect(res.status).toBe(200);
    expectResponse('/assets/{id}', 'put', 200, res.json);
    expect(res.json).toMatchObject({ isFavorite: true, isArchived: true, visibility: 'archive' });
    expect(res.json.exifInfo).toMatchObject({ description: 'On the beach', latitude: 47.37, longitude: 8.54, rating: 4, timeZone: 'UTC+2', dateTimeOriginal: '2023-07-01T10:30:00.000Z' });
    const a = await asset(ids[0]);
    expect(a.local_date_time).toBe('2023-07-01T12:30:00.000Z');
    expect(a.update_id > before.update_id).toBe(true);
    const e = await exif(ids[0]);
    expect(e.update_id).not.toBe(a.update_id); // one cursor per synced row
    expect(JSON.parse(e.locked_properties).sort()).toEqual(['dateTimeOriginal', 'description', 'latitude', 'longitude', 'rating', 'timeZone']);
  });

  it('emits AssetV2 and AssetExifV1 sync lines for the edit', async () => {
    const { token, ids } = await setupAssets();
    await call(token, 'PUT', `/assets/${ids[0]}`, { isFavorite: true, description: 'x' });
    const lines = await sync(token, ['AssetsV2', 'AssetExifsV1']);
    const a = lines.find((l) => l.type === 'AssetV2')!;
    const e = lines.find((l) => l.type === 'AssetExifV1')!;
    expectSchema('SyncAssetV2', a.data);
    expectSchema('SyncAssetExifV1', e.data);
    expect(a.data.isFavorite).toBe(true);
    expect(e.data.description).toBe('x');
  });

  it('rejects bad input with 400 and other users assets with 400', async () => {
    const { token, ids, other } = await setupAssets(1, { second: true });
    const bad = [
      { latitude: 120 },
      { longitude: 'x' },
      { rating: 9 },
      { rating: 1.5 },
      { visibility: 'nope' },
      { isFavorite: 'yes' },
      { dateTimeOriginal: 'yesterday' },
      { description: 5 },
      { livePhotoVideoId: 'not-a-uuid' },
    ];
    for (const b of bad) expect((await call(token, 'PUT', `/assets/${ids[0]}`, b)).status, JSON.stringify(b)).toBe(400);
    expect((await call(token, 'PUT', '/assets/not-a-uuid', {})).status).toBe(400);
    expect((await call(token, 'PUT', `/assets/${crypto.randomUUID()}`, {})).status).toBe(400);
    expect((await call(other, 'PUT', `/assets/${ids[0]}`, { isFavorite: true })).status).toBe(400);
    expect((await asset(ids[0])).is_favorite).toBe(0);
    expect((await call('bogus', 'PUT', `/assets/${ids[0]}`, {})).status).toBe(401);
  });

  it('rejects locked visibility with 403 until the PIN session exists', async () => {
    const { token, ids } = await setupAssets();
    const res = await call(token, 'PUT', `/assets/${ids[0]}`, { visibility: 'locked' });
    expect(res.status).toBe(403);
    expect((await asset(ids[0])).visibility).toBe('timeline');
    await env.DB.prepare("UPDATE assets SET visibility = 'locked' WHERE id = ?1").bind(ids[0]).run();
    // a locked asset counts as missing until sessions can be elevated
    expect((await call(token, 'PUT', `/assets/${ids[0]}`, { visibility: 'timeline' })).status).toBe(400);
  });

  it('keeps edited exif columns when the asset is processed afterwards', async () => {
    const { token } = await setupAssets(0);
    const id = (await uploadAsset(token, new Uint8Array(sampleJpg))).body.id;
    expect((await call(token, 'PUT', `/assets/${id}`, { description: 'mine', dateTimeOriginal: '2020-02-02T10:00:00.000Z', rating: 2 })).status).toBe(200);
    const png = encode({ width: 4, height: 3, data: new Uint8Array(48).fill(1), channels: 4 });
    const t: Thumbnailer = { render: async () => png, info: async () => ({ width: 4, height: 3 }) };
    await processAsset(env, id, t);
    const e = await exif(id);
    expect(e.description).toBe('mine');
    expect(e.rating).toBe(2);
    expect(e.date_time_original).toBe('2020-02-02T10:00:00.000Z');
    expect(e.make).toBeTruthy(); // unlocked columns still come from the file
    const a = await asset(id);
    expect(a.status).toBe('ready');
    expect(a.local_date_time).toBe('2020-02-02T10:00:00.000Z');
  });

  it('links and unlinks a live photo video', async () => {
    const { token, ids } = await setupAssets(1);
    const video = (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(50)), { filename: 'clip.mov' })).body.id;
    expect((await call(token, 'PUT', `/assets/${ids[0]}`, { livePhotoVideoId: video })).status).toBe(200);
    expect((await asset(ids[0])).live_photo_video_id).toBe(video);
    expect((await asset(video)).visibility).toBe('hidden');
    expect((await call(token, 'PUT', `/assets/${ids[0]}`, { livePhotoVideoId: ids[0] })).status).toBe(400); // not a video
    expect((await call(token, 'PUT', `/assets/${ids[0]}`, { livePhotoVideoId: null })).status).toBe(200);
    expect((await asset(ids[0])).live_photo_video_id).toBeNull();
    expect((await asset(video)).visibility).toBe('timeline');
  });
});

describe('PUT /assets (bulk)', () => {
  it('updates several assets with one tracked statement each', async () => {
    const { token, ids } = await setupAssets(3);
    const res = await call(token, 'PUT', '/assets', { ids, isFavorite: true, visibility: 'archive', rating: null });
    expect(res.status).toBe(204);
    const rows = await Promise.all(ids.map(asset));
    expect(rows.every((r) => r.is_favorite === 1 && r.visibility === 'archive')).toBe(true);
    expect(new Set(rows.map((r) => r.update_id)).size).toBe(3);
    const lines = await sync(token, ['AssetsV2']);
    expect(lines.filter((l) => l.type === 'AssetV2')).toHaveLength(3);
  });

  it('shifts dateTimeOriginal relatively and sets a time zone', async () => {
    const { token, ids } = await setupAssets(2);
    await call(token, 'PUT', '/assets', { ids, dateTimeOriginal: '2022-01-01T00:00:00.000Z' });
    expect((await call(token, 'PUT', '/assets', { ids, dateTimeRelative: 90 })).status).toBe(204);
    expect((await exif(ids[0])).date_time_original).toBe('2022-01-01T01:30:00.000Z');
    expect((await call(token, 'PUT', '/assets', { ids, timeZone: 'Europe/Zurich' })).status).toBe(204);
    expect((await exif(ids[0])).time_zone).toBe('Europe/Zurich');
    expect((await asset(ids[0])).local_date_time).toBe('2022-01-01T02:30:00.000Z');
    expect((await call(token, 'PUT', '/assets', { ids, timeZone: 'Mars/Base' })).status).toBe(400);
  });

  it('rejects foreign, malformed and locked requests', async () => {
    const { token, ids, other } = await setupAssets(2, { second: true });
    expect((await call(other, 'PUT', '/assets', { ids, isFavorite: true })).status).toBe(400);
    expect((await call(token, 'PUT', '/assets', { ids: [...ids, crypto.randomUUID()], isFavorite: true })).status).toBe(400);
    expect((await call(token, 'PUT', '/assets', { ids: ['x'], isFavorite: true })).status).toBe(400);
    expect((await call(token, 'PUT', '/assets', { isFavorite: true })).status).toBe(400);
    expect((await call(token, 'PUT', '/assets', { ids, visibility: 'locked' })).status).toBe(403);
    expect((await asset(ids[0])).is_favorite).toBe(0);
  });
});

describe('PUT /assets/copy', () => {
  it('copies the favorite flag', async () => {
    const { token, ids, other } = await setupAssets(2, { second: true });
    await call(token, 'PUT', '/assets', { ids: [ids[0]], isFavorite: true });
    expect((await call(token, 'PUT', '/assets/copy', { sourceId: ids[0], targetId: ids[1] })).status).toBe(204);
    expect((await asset(ids[1])).is_favorite).toBe(1);
    expect((await call(token, 'PUT', '/assets/copy', { sourceId: ids[0], targetId: ids[0] })).status).toBe(400);
    expect((await call(other, 'PUT', '/assets/copy', { sourceId: ids[0], targetId: ids[1] })).status).toBe(400);
    expect((await call(token, 'PUT', '/assets/copy', { sourceId: 'x', targetId: ids[1] })).status).toBe(400);
  });
});

describe('POST /assets/jobs', () => {
  it('resets assets to pending and enqueues processing for refresh and thumbnail jobs', async () => {
    const { token, ids, other } = await setupAssets(1, { second: true });
    await env.DB.prepare("UPDATE assets SET status = 'ready' WHERE id = ?1").bind(ids[0]).run();
    const before = (await asset(ids[0])).update_id;
    for (const name of ['refresh-metadata', 'regenerate-thumbnail']) {
      await env.DB.prepare("UPDATE assets SET status = 'ready' WHERE id = ?1").bind(ids[0]).run();
      expect((await call(token, 'POST', '/assets/jobs', { assetIds: ids, name })).status).toBe(204);
      const a = await asset(ids[0]);
      expect(a.status).toBe('pending');
      expect(a.update_id > before).toBe(true);
    }
    for (const name of ['refresh-faces', 'transcode-video']) {
      expect((await call(token, 'POST', '/assets/jobs', { assetIds: ids, name })).status).toBe(204);
    }
    expect((await call(token, 'POST', '/assets/jobs', { assetIds: ids, name: 'nope' })).status).toBe(400);
    expect((await call(other, 'POST', '/assets/jobs', { assetIds: ids, name: 'refresh-metadata' })).status).toBe(400);
  });
});
