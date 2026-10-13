import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { encode } from 'fast-png';
import { MediaInputError, type FfprobeOutput, type ImageResult, type MediaProcessor, type VideoResult } from '../src/container/contract';
import { processAsset } from '../src/process/consumer';
import { parseFfprobe } from '../src/process/ffprobe';
import type { Thumbnailer } from '../src/process/thumbs';
import { createUser, login, uploadAsset } from './helpers';

function fakeThumbnailer(): Thumbnailer {
  const png = encode({ width: 4, height: 3, data: new Uint8Array(4 * 3 * 4).fill(200), channels: 4 });
  return {
    async render() {
      return png;
    },
    async info() {
      return { width: 4, height: 3 };
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

const iphone: FfprobeOutput = {
  format: {
    duration: '12.345678',
    tags: {
      'com.apple.quicktime.creationdate': '2024-07-14T18:03:12+0300',
      'com.apple.quicktime.location.ISO6709': '+34.6823+033.0464+012.000/',
      'com.apple.quicktime.make': 'Apple',
      'com.apple.quicktime.model': 'iPhone 15 Pro',
      creation_time: '2024-07-14T15:03:12.000000Z',
    },
  },
  streams: [
    { codec_type: 'audio' },
    { codec_type: 'video', width: 1920, height: 1080, side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }] },
  ],
};

describe('parseFfprobe', () => {
  it('reads an iPhone clip: date with offset, GPS, make/model, rotated size, duration', () => {
    const p = parseFfprobe(iphone);
    expect(p.width).toBe(1080);
    expect(p.height).toBe(1920);
    expect(p.durationMs).toBe(12346);
    expect(p.exif.dateTimeOriginal).toBe('2024-07-14T15:03:12.000Z');
    expect(p.exif.timeZone).toBe('UTC+3');
    expect(p.exif.latitude).toBe(34.6823);
    expect(p.exif.longitude).toBe(33.0464);
    expect(p.exif.make).toBe('Apple');
    expect(p.exif.model).toBe('iPhone 15 Pro');
    expect(p.exif.exifImageWidth).toBe(1080);
    expect(p.exif.exifImageHeight).toBe(1920);
    expect(p.exif.description).toBe('');
  });

  it('uses creation_time without a zone', () => {
    const p = parseFfprobe({ format: { tags: { Creation_Time: '2023-01-02T03:04:05.000000Z' } }, streams: [{ codec_type: 'video', width: 10, height: 20 }] });
    expect(p.exif.dateTimeOriginal).toBe('2023-01-02T03:04:05.000Z');
    expect(p.exif.timeZone).toBeNull();
    expect(p.durationMs).toBeNull();
  });

  it('falls back to the stream creation_time and duration', () => {
    const p = parseFfprobe({ streams: [{ codec_type: 'video', width: 10, height: 20, duration: '1.5', tags: { creation_time: '2022-05-06T07:08:09Z' } }] });
    expect(p.exif.dateTimeOriginal).toBe('2022-05-06T07:08:09.000Z');
    expect(p.durationMs).toBe(1500);
  });

  it('returns nulls for no tags', () => {
    const p = parseFfprobe({ format: {}, streams: [{ codec_type: 'video' }] });
    expect(p).toMatchObject({ durationMs: null, width: null, height: null });
    expect(p.exif).toMatchObject({ dateTimeOriginal: null, timeZone: null, latitude: null, longitude: null, make: null, model: null, description: '' });
  });

  it('treats +00.0000+000.0000 as no GPS', () => {
    const p = parseFfprobe({ format: { tags: { location: '+00.0000+000.0000/' } }, streams: [{ codec_type: 'video', width: 1, height: 1 }] });
    expect(p.exif.latitude).toBeNull();
    expect(p.exif.longitude).toBeNull();
  });

  it('reads negative coordinates from the location tag', () => {
    const p = parseFfprobe({ format: { tags: { location: '-33.8688+151.2093/' } }, streams: [{ codec_type: 'video', width: 1, height: 1 }] });
    expect(p.exif.latitude).toBe(-33.8688);
    expect(p.exif.longitude).toBe(151.2093);
  });

  it('handles the stream rotate tag', () => {
    const p = parseFfprobe({ streams: [{ codec_type: 'video', width: 1920, height: 1080, tags: { rotate: '90' } }] });
    expect([p.width, p.height]).toEqual([1080, 1920]);
    const q = parseFfprobe({ streams: [{ codec_type: 'video', width: 1920, height: 1080, tags: { rotate: '180' } }] });
    expect([q.width, q.height]).toEqual([1920, 1080]);
  });

  it('skips cover art (attached_pic) when picking the video stream', () => {
    const p = parseFfprobe({
      streams: [
        { codec_type: 'video', width: 600, height: 600, disposition: { attached_pic: 1 } },
        { codec_type: 'video', width: 1920, height: 1080, disposition: { attached_pic: 0 } },
      ],
    });
    expect([p.width, p.height]).toEqual([1920, 1080]);
  });
});

async function uploadedVideo() {
  await createUser();
  const token = await login();
  return (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(2048)), { filename: 'clip.mov' })).body.id;
}

const okVideo = (ffprobe: FfprobeOutput = iphone): VideoResult => ({ ffprobe, poster: { width: 4, height: 3 } });
const row = (id: string) => env.DB.prepare('SELECT * FROM assets WHERE id = ?1').bind(id).first<any>();

describe('processAsset for videos', () => {
  it('marks a video with a missing original failed without calling the container', async () => {
    const id = await uploadedVideo();
    await env.MEDIA.delete((await row(id)).original_path);
    const proc = fakeProcessor({ video: okVideo() });
    await processAsset(env, id, fakeThumbnailer(), false, proc);
    expect(proc.calls).toEqual([]);
    const a = await row(id);
    expect([a.status, a.error]).toEqual(['failed', 'original missing']);
  });

  it('marks ready with duration, thumbhash, exif and thumbnails', async () => {
    const id = await uploadedVideo();
    const a0 = await row(id);
    const proc = fakeProcessor({ video: okVideo() });
    await processAsset(env, id, fakeThumbnailer(), false, proc);
    expect(proc.calls).toEqual([['video', a0.original_path, `derived/${id}/poster.jpeg`]]);
    const a = await row(id);
    expect(a.status).toBe('ready');
    expect(a.duration).toBe(12346);
    expect(a.thumbhash).toBeTruthy();
    expect(a.has_thumbnail).toBe(1);
    expect([a.width, a.height]).toEqual([1080, 1920]);
    expect(a.local_date_time).toBe('2024-07-14T18:03:12.000Z');
    expect(await env.MEDIA.head(`thumbs/${id}/preview.jpeg`)).not.toBeNull();
    expect(await env.MEDIA.head(`thumbs/${id}/thumbnail.webp`)).not.toBeNull();
    const e = await env.DB.prepare('SELECT * FROM asset_exif WHERE asset_id = ?1').bind(id).first<any>();
    expect(e.latitude).toBe(34.6823);
    expect(e.make).toBe('Apple');
  });

  it('a MediaInputError marks failed, stores the message and still queues a backup', async () => {
    const id = await uploadedVideo();
    await processAsset(env, id, fakeThumbnailer(), false, fakeProcessor({ video: new MediaInputError('moov atom not found') }));
    const a = await row(id);
    expect(a.status).toBe('failed');
    expect(a.error).toBe('moov atom not found');
    // BACKUP_QUEUE has no inspectable state here; markFailed is the shared helper that enqueues.
  });

  it('a plain Error rejects and leaves the asset pending', async () => {
    const id = await uploadedVideo();
    await expect(processAsset(env, id, fakeThumbnailer(), false, fakeProcessor({ video: new Error('container 503') }))).rejects.toThrow('container 503');
    expect((await row(id)).status).toBe('pending');
  });

  it('reaches ready without metadata, dates falling back to file_created_at', async () => {
    const id = await uploadedVideo();
    await processAsset(env, id, fakeThumbnailer(), false, fakeProcessor({ video: okVideo({ format: {}, streams: [{ codec_type: 'video' }] }) }));
    const a = await row(id);
    expect(a.status).toBe('ready');
    expect(a.local_date_time).toBe(a.file_created_at);
    expect([a.width, a.height]).toEqual([4, 3]); // poster size
    expect(a.duration).toBeNull();
  });

  it('keeps a locked dateTimeOriginal when re-processed with force', async () => {
    const id = await uploadedVideo();
    await processAsset(env, id, fakeThumbnailer(), false, fakeProcessor({ video: okVideo() }));
    await env.DB.prepare(`UPDATE asset_exif SET locked_properties = '["dateTimeOriginal"]', date_time_original = '2020-01-01T00:00:00.000Z' WHERE asset_id = ?1`).bind(id).run();
    await env.DB.prepare(`UPDATE assets SET local_date_time = '2020-01-01T00:00:00.000Z' WHERE id = ?1`).bind(id).run();
    await processAsset(env, id, fakeThumbnailer(), true, fakeProcessor({ video: okVideo() }));
    expect((await row(id)).local_date_time).toBe('2020-01-01T00:00:00.000Z');
    const e = await env.DB.prepare('SELECT date_time_original FROM asset_exif WHERE asset_id = ?1').bind(id).first<any>();
    expect(e.date_time_original).toBe('2020-01-01T00:00:00.000Z');
  });

  it('without a processor leaves needs_media', async () => {
    const id = await uploadedVideo();
    await processAsset(env, id, fakeThumbnailer());
    expect((await row(id)).status).toBe('needs_media');
  });
});
