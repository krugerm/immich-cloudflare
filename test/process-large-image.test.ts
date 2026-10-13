import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { encode } from 'fast-png';
import { MediaInputError, type ImageResult, type MediaProcessor, type VideoResult } from '../src/container/contract';
import { processAsset } from '../src/process/consumer';
import { mapExiftool } from '../src/process/exiftool-map';
import type { Thumbnailer } from '../src/process/thumbs';
import { createUser, login, uploadAsset } from './helpers';
import sampleJpg from './fixtures/media/sample.jpg?arraybuffer';

type Call = { width?: number; height?: number; format: string };
function fakeThumbnailer(fail: boolean | Error = false, dims = { width: 4, height: 3 }): Thumbnailer & { calls: Call[] } {
  const png = encode({ width: 4, height: 3, data: new Uint8Array(4 * 3 * 4).fill(200), channels: 4 });
  const calls: Call[] = [];
  return {
    calls,
    async render(_input, opts) {
      if (fail) throw fail instanceof Error ? fail : new Error('ERROR 9412: Unsupported image');
      calls.push({ ...(opts.width ? { width: opts.width } : {}), ...(opts.height ? { height: opts.height } : {}), format: opts.format });
      return png;
    },
    async info() {
      return dims;
    },
  };
}

function fakeProcessor(over: Partial<{ video: VideoResult | Error; image: ImageResult | Error }>): MediaProcessor & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async video(key, posterKey) {
      calls.push(['video', key, posterKey]);
      const v = over.video;
      if (v instanceof Error) throw v;
      await env.MEDIA.put(posterKey, new Uint8Array([0xff, 0xd8, 0xff]));
      return v!;
    },
    async image(key, outKey) {
      calls.push(['image', key, outKey]);
      const i = over.image;
      if (i instanceof Error) throw i;
      await env.MEDIA.put(outKey, new Uint8Array([0xff, 0xd8, 0xff]));
      return i!;
    },
  };
}

const SONY = {
  Make: 'SONY', Model: 'ILCE-7M4', LensModel: 'FE 24-70mm F2.8 GM', ExposureTime: 0.004, FNumber: 2.8, FocalLength: 35, ISO: 400,
  DateTimeOriginal: '2024:07:14 18:03:12', OffsetTimeOriginal: '+03:00', Orientation: 6, ImageWidth: 7008, ImageHeight: 4672,
};
const out: ImageResult['output'] = { width: 4096, height: 2731 };

async function uploaded(filename: string, bytes = new Uint8Array(sampleJpg)) {
  await createUser();
  const token = await login();
  return (await uploadAsset(token, bytes, { filename })).body.id as string;
}

describe('mapExiftool', () => {
  it('maps a Sony ARW-style object', () => {
    const e = mapExiftool(SONY);
    expect(e).toMatchObject({
      make: 'SONY', model: 'ILCE-7M4', lensModel: 'FE 24-70mm F2.8 GM', exposureTime: '1/250', fNumber: 2.8, focalLength: 35, iso: 400,
      dateTimeOriginal: '2024-07-14T15:03:12.000Z', timeZone: 'UTC+3', orientation: '6', exifImageWidth: 7008, exifImageHeight: 4672,
      width: 7008, height: 4672, description: '', rating: null,
    });
  });

  it('maps an empty object to nulls and an empty description', () => {
    expect(mapExiftool({})).toEqual({
      make: null, model: null, lensModel: null, exposureTime: null, fNumber: null, focalLength: null, iso: null, latitude: null,
      longitude: null, dateTimeOriginal: null, timeZone: null, orientation: null, rating: null, description: '', exifImageWidth: null,
      exifImageHeight: null, profileDescription: null, projectionType: null, width: null, height: null,
    });
  });

  it('treats GPS 0/0 as none and keeps six decimals otherwise', () => {
    expect(mapExiftool({ GPSLatitude: 0, GPSLongitude: 0 })).toMatchObject({ latitude: null, longitude: null });
    expect(mapExiftool({ GPSLatitude: 47.1234567891, GPSLongitude: -8.5 })).toMatchObject({ latitude: 47.123457, longitude: -8.5 });
  });

  it('falls back on Lens, ImageWidth, and bounds Rating', () => {
    expect(mapExiftool({ Lens: 'Kit', ImageWidth: 10, ImageHeight: 20, Rating: 0 })).toMatchObject({
      lensModel: 'Kit', exifImageWidth: 10, exifImageHeight: 20, rating: null,
    });
    expect(mapExiftool({ Rating: 4, ExposureTime: 2, ImageDescription: 'x', ProjectionType: 'equirectangular' })).toMatchObject({
      rating: 4, exposureTime: '2', description: 'x', projectionType: 'EQUIRECTANGULAR',
    });
  });
});

describe('processAsset with the media container', () => {
  const row = (id: string) => env.DB.prepare('SELECT * FROM assets WHERE id = ?1').bind(id).first<any>();

  it('sends a RAW (.dng) through processor.image and ends ready with exif and swapped size', async () => {
    const id = await uploaded('IMG_0001.DNG');
    const p = fakeProcessor({ image: { exiftool: SONY, output: out } });
    const t = fakeThumbnailer();
    await processAsset(env, id, t, false, p);
    expect(p.calls).toEqual([['image', expect.stringContaining('/'), `derived/${id}/full.jpeg`]]);
    const a = await row(id);
    expect(a.status).toBe('ready');
    expect(a.has_thumbnail).toBe(1);
    expect(a.thumbhash).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(a.width).toBe(4672);
    expect(a.height).toBe(7008);
    expect(a.local_date_time).toBe('2024-07-14T18:03:12.000Z');
    const exif = await env.DB.prepare('SELECT * FROM asset_exif WHERE asset_id = ?1').bind(id).first<any>();
    expect(exif).toMatchObject({ make: 'SONY', exposure_time: '1/250', orientation: '6', time_zone: 'UTC+3' });
    expect(await env.MEDIA.head(`thumbs/${id}/thumbnail.webp`)).not.toBeNull();
    // the container JPEG is upright, so thumbnails get no orientation swap: 4x3 landscape short side is height
    expect(t.calls[0]).toEqual({ height: 1440, format: 'image/jpeg' });
  });

  it('sends a 25 MB jpg through processor.image', async () => {
    const id = await uploaded('big.jpg');
    await env.DB.prepare('UPDATE assets SET file_size = ?2 WHERE id = ?1').bind(id, 25 * 1024 * 1024).run();
    const p = fakeProcessor({ image: { exiftool: SONY, output: out } });
    await processAsset(env, id, fakeThumbnailer(), false, p);
    expect(p.calls).toHaveLength(1);
    expect((await row(id)).status).toBe('ready');
  });

  it('reaches ready without metadata, with dates from file_created_at and size from the thumbnail', async () => {
    const id = await uploaded('stripped.dng');
    await processAsset(env, id, fakeThumbnailer(), false, fakeProcessor({ image: { exiftool: {}, output: out } }));
    const a = await row(id);
    const exif = await env.DB.prepare('SELECT * FROM asset_exif WHERE asset_id = ?1').bind(id).first<any>();
    expect(a.status).toBe('ready');
    expect(a.local_date_time).toBe(new Date(a.file_created_at).toISOString());
    expect(exif.date_time_original).toBe(a.file_created_at);
    expect([a.width, a.height]).toEqual([4, 3]);
  });

  it('marks failed on MediaInputError', async () => {
    const id = await uploaded('bad.dng');
    await processAsset(env, id, fakeThumbnailer(), false, fakeProcessor({ image: new MediaInputError('cannot decode') }));
    const a = await row(id);
    expect(a.status).toBe('failed');
    expect(a.error).toContain('cannot decode');
  });

  it('rejects on a plain Error and leaves the asset unfailed', async () => {
    const id = await uploaded('flaky.dng');
    await expect(processAsset(env, id, fakeThumbnailer(), false, fakeProcessor({ image: new Error('container 503') }))).rejects.toThrow('503');
    expect((await row(id)).status).not.toBe('failed');
  });

  it('marks failed with exif when the Images binding rejects the container JPEG', async () => {
    const id = await uploaded('weird.dng');
    await processAsset(env, id, fakeThumbnailer(true), false, fakeProcessor({ image: { exiftool: SONY, output: out } }));
    expect((await row(id)).status).toBe('failed');
    expect((await env.DB.prepare('SELECT make FROM asset_exif WHERE asset_id = ?1').bind(id).first<any>()).make).toBe('SONY');
  });

  it('keeps small JPEGs on the Images path', async () => {
    const id = await uploaded('small.jpg');
    const p = fakeProcessor({});
    await processAsset(env, id, fakeThumbnailer(), false, p);
    expect(p.calls).toEqual([]);
    expect((await row(id)).status).toBe('ready');
  });
});
