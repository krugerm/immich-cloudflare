import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULTS, updateSystemConfig } from '../src/config/store';
import type { AssetRow } from '../src/db/rows';
import { markReady, processAsset } from '../src/process/consumer';
import { extractExif, type ExtractedExif } from '../src/process/exif';
import type { Thumbnailer } from '../src/process/thumbs';
import { encode } from 'fast-png';
import { createUser, login, uploadAsset } from './helpers';
import { loadPlaces } from './geo-helpers';
import sampleJpg from './fixtures/media/sample.jpg?arraybuffer';

beforeEach(loadPlaces);

const png = encode({ width: 4, height: 3, data: new Uint8Array(4 * 3 * 4).fill(200), channels: 4 });
const thumbnailer: Thumbnailer = { render: async () => png, info: async () => ({ width: 4, height: 3 }) };

async function upload(filename = 'IMG_0001.JPG', bytes = new Uint8Array(sampleJpg)) {
  await createUser();
  const token = await login();
  return (await uploadAsset(token, bytes, { filename })).body.id;
}

const baseExif = async (): Promise<ExtractedExif> => ({ ...(await extractExif(new Uint8Array([1, 2, 3]))) });
const assetRow = (id: string) => env.DB.prepare('SELECT * FROM assets WHERE id = ?1').bind(id).first<AssetRow>() as Promise<AssetRow>;
const exifRow = (id: string) => env.DB.prepare('SELECT * FROM asset_exif WHERE asset_id = ?1').bind(id).first<any>();

describe('geocoding in the processing paths', () => {
  it('fills city, state and country and the GPS zone for a processed photo', async () => {
    const id = await upload();
    await processAsset(env, id, thumbnailer);
    const e = await exifRow(id);
    expect(e).toMatchObject({ city: 'Arezzo', state: 'Tuscany', country: 'Italy' });
    expect(e.time_zone).toBeTruthy();
    const a = await assetRow(id);
    // The wall-clock time of the photo is what local_date_time shows, whichever zone is recorded.
    const raw = await extractExif(new Uint8Array(sampleJpg));
    expect(raw.timeZone).toBeNull(); // the sample has no offset tag, so the GPS zone applies
    expect(e.time_zone).toBe('Europe/Rome');
    expect(a.local_date_time).toBe(raw.dateTimeOriginal);
    expect(e.date_time_original).not.toBe(raw.dateTimeOriginal);
  });

  it('a photo without GPS gets no place and no zone', async () => {
    const id = await upload();
    await markReady(env, await assetRow(id), new Date().toISOString(), { exif: { ...(await baseExif()), dateTimeOriginal: '2024-05-04T10:00:00.000Z' }, thumbhash: 'x', width: 4, height: 3 });
    const e = await exifRow(id);
    expect(e.city).toBeNull();
    expect(e.time_zone).toBeNull();
    expect((await assetRow(id)).local_date_time).toBe('2024-05-04T10:00:00.000Z');
  });

  it('keeps an EXIF offset and does not apply the GPS zone', async () => {
    const id = await upload();
    const exif = { ...(await baseExif()), latitude: 47.3667, longitude: 8.55, dateTimeOriginal: '2024-05-04T08:00:00.000Z', timeZone: 'UTC+2' };
    await markReady(env, await assetRow(id), new Date().toISOString(), { exif, thumbhash: 'x', width: 4, height: 3 });
    const e = await exifRow(id);
    expect(e).toMatchObject({ time_zone: 'UTC+2', date_time_original: '2024-05-04T08:00:00.000Z', city: 'Zurich', country: 'Switzerland' });
    expect((await assetRow(id)).local_date_time).toBe('2024-05-04T10:00:00.000Z');
  });

  it('wall-clock EXIF with GPS moves dateTimeOriginal to the real instant and keeps local_date_time', async () => {
    const id = await upload();
    const exif = { ...(await baseExif()), latitude: 47.3667, longitude: 8.55, dateTimeOriginal: '2024-05-04T10:00:00.000Z' };
    await markReady(env, await assetRow(id), new Date().toISOString(), { exif, thumbhash: 'x', width: 4, height: 3 });
    const e = await exifRow(id);
    expect(e).toMatchObject({ time_zone: 'Europe/Zurich', date_time_original: '2024-05-04T08:00:00.000Z' });
    expect((await assetRow(id)).local_date_time).toBe('2024-05-04T10:00:00.000Z');
  });

  it('a video with a UTC creation time and GPS keeps the instant and shifts local_date_time', async () => {
    const id = await upload();
    const exif = { ...(await baseExif()), latitude: 35.6895, longitude: 139.6917, dateTimeOriginal: '2024-05-04T01:00:00.000Z' };
    await markReady(env, await assetRow(id), new Date().toISOString(), { exif, thumbhash: 'x', width: 4, height: 3, durationMs: 1000 });
    const e = await exifRow(id);
    expect(e).toMatchObject({ time_zone: 'Asia/Tokyo', date_time_original: '2024-05-04T01:00:00.000Z', city: 'Tokyo' });
    expect((await assetRow(id)).local_date_time).toBe('2024-05-04T10:00:00.000Z');
  });

  it('leaves place null when reverseGeocoding is disabled, but still sets the zone', async () => {
    await updateSystemConfig(env.DB, { ...DEFAULTS, reverseGeocoding: { enabled: false } });
    const id = await upload();
    const exif = { ...(await baseExif()), latitude: 47.3667, longitude: 8.55 };
    await markReady(env, await assetRow(id), new Date().toISOString(), { exif, thumbhash: 'x', width: 4, height: 3 });
    const e = await exifRow(id);
    expect(e.city).toBeNull();
    expect(e.time_zone).toBe('Europe/Zurich');
  });

  it('a hand-edited location keeps its place when the asset is processed again', async () => {
    const id = await upload();
    const exif = { ...(await baseExif()), latitude: 47.3667, longitude: 8.55 };
    await markReady(env, await assetRow(id), new Date().toISOString(), { exif, thumbhash: 'x', width: 4, height: 3 });
    await env.DB.prepare(`UPDATE asset_exif SET locked_properties = '["latitude","longitude"]', city = 'Home' WHERE asset_id = ?1`).bind(id).run();
    await markReady(env, await assetRow(id), new Date().toISOString(), { exif, thumbhash: 'x', width: 4, height: 3 });
    expect((await exifRow(id)).city).toBe('Home');
  });

  it('disabling geocoding keeps the stored place when the asset is processed again', async () => {
    const id = await upload();
    const exif = { ...(await baseExif()), latitude: 47.3667, longitude: 8.55 };
    await markReady(env, await assetRow(id), new Date().toISOString(), { exif, thumbhash: 'x', width: 4, height: 3 });
    await updateSystemConfig(env.DB, { ...DEFAULTS, reverseGeocoding: { enabled: false } });
    await markReady(env, await assetRow(id), new Date().toISOString(), { exif, thumbhash: 'x', width: 4, height: 3 });
    expect(await exifRow(id)).toMatchObject({ city: 'Zurich', state: 'Zurich', country: 'Switzerland' });
  });

  it('a locked timeZone is not replaced by the GPS zone and the date is not shifted', async () => {
    const id = await upload();
    const exif = { ...(await baseExif()), latitude: 47.3667, longitude: 8.55, dateTimeOriginal: '2024-05-04T10:00:00.000Z' };
    await markReady(env, await assetRow(id), new Date().toISOString(), { exif, thumbhash: 'x', width: 4, height: 3 });
    await env.DB.prepare(`UPDATE asset_exif SET locked_properties = '["timeZone"]', time_zone = 'Asia/Tokyo' WHERE asset_id = ?1`).bind(id).run();
    await markReady(env, await assetRow(id), new Date().toISOString(), { exif, thumbhash: 'x', width: 4, height: 3 });
    expect(await exifRow(id)).toMatchObject({ time_zone: 'Asia/Tokyo', date_time_original: '2024-05-04T10:00:00.000Z' });
    expect((await assetRow(id)).local_date_time).toBe('2024-05-04T10:00:00.000Z');
  });
});
