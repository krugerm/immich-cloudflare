import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { containerProcessor } from '../src/container/client';
import { MediaInputError, type ImageResult, type VideoResult } from '../src/container/contract';
import { verifyGrant } from '../src/container/grant';

interface Call {
  name: string;
  url: string;
  init: RequestInit | undefined;
}

/** A DurableObjectNamespace stand-in: idFromName/get return stubs whose fetch runs `respond`. */
function fakeNamespace(respond: (url: string, init?: RequestInit) => Promise<Response>) {
  const calls: Call[] = [];
  const ns = {
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => ({
      fetch: async (url: string, init?: RequestInit) => {
        calls.push({ name: id.name, url, init });
        return respond(url, init);
      },
    }),
  };
  return { calls, env: { ...env, MEDIA_CONTAINER: ns } as unknown as Env };
}

const video: VideoResult = { ffprobe: { format: { duration: '1.5' } }, poster: { width: 1080, height: 1920 } };
const image: ImageResult = { exiftool: { Make: 'Canon' }, output: { width: 4096, height: 2731 } };

describe('container client', () => {
  it('posts the video job to one of 3 instances and returns the parsed result', async () => {
    const fake = fakeNamespace(async () => Response.json(video));
    const result = await containerProcessor(fake.env)!.video('originals/u/a.mov', 'derived/x/poster.jpeg');
    expect(result).toEqual(video);
    expect(fake.calls).toHaveLength(1);
    const [call] = fake.calls;
    expect(call.name).toMatch(/^instance-[0-2]$/);
    expect(call.url).toBe('http://container/video');
    expect(call.init?.method).toBe('POST');
    expect(new Headers(call.init?.headers).get('content-type')).toBe('application/json');
    // Keys travel as per-job grants: a read grant for the original, a write grant for the poster.
    const sent = JSON.parse(call.init?.body as string) as { key: string; posterKey: string };
    expect(await verifyGrant(env.MEDIA_GRANT_SECRET!, 'read', sent.key)).toBe('originals/u/a.mov');
    expect(await verifyGrant(env.MEDIA_GRANT_SECRET!, 'write', sent.posterKey)).toBe('derived/x/poster.jpeg');
    expect(await verifyGrant(env.MEDIA_GRANT_SECRET!, 'write', sent.key)).toBeNull();
    expect(call.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('posts the image job with outKey', async () => {
    const fake = fakeNamespace(async () => Response.json(image));
    const result = await containerProcessor(fake.env)!.image('originals/u/a.cr3', 'derived/x/full.jpeg');
    expect(result).toEqual(image);
    expect(fake.calls[0].url).toBe('http://container/image');
    const sent = JSON.parse(fake.calls[0].init?.body as string) as { key: string; outKey: string };
    expect(await verifyGrant(env.MEDIA_GRANT_SECRET!, 'read', sent.key)).toBe('originals/u/a.cr3');
    expect(await verifyGrant(env.MEDIA_GRANT_SECRET!, 'write', sent.outKey)).toBe('derived/x/full.jpeg');
  });

  it('maps 422 to MediaInputError with the container message', async () => {
    const fake = fakeNamespace(async () => Response.json({ error: 'moov atom not found' }, { status: 422 }));
    const p = containerProcessor(fake.env)!.video('originals/u/a.mov', 'derived/x/poster.jpeg');
    await expect(p).rejects.toBeInstanceOf(MediaInputError);
    await expect(p).rejects.toThrow('moov atom not found');
  });

  it('maps 500 to a plain Error so the queue retries', async () => {
    const fake = fakeNamespace(async () => new Response('ffmpeg crashed', { status: 500 }));
    const err = await containerProcessor(fake.env)!
      .image('originals/u/a.cr3', 'derived/x/full.jpeg')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(MediaInputError);
    expect((err as Error).message).toBe('media container 500: ffmpeg crashed');
  });

  it('maps a timeout or stub failure to a plain Error', async () => {
    const fake = fakeNamespace(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    const err = await containerProcessor(fake.env)!
      .video('originals/u/a.mov', 'derived/x/poster.jpeg')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(MediaInputError);
    expect((err as Error).message).toMatch(/^media container (timeout|error)/);
  });

  it('treats a 422 without a JSON body as MediaInputError', async () => {
    const fake = fakeNamespace(async () => new Response('bad input', { status: 422 }));
    const p = containerProcessor(fake.env)!.video('originals/u/a.mov', 'derived/x/poster.jpeg');
    await expect(p).rejects.toBeInstanceOf(MediaInputError);
    await expect(p).rejects.toThrow('bad input');
  });

  it('returns undefined without MEDIA_GRANT_SECRET, so assets wait in needs_media instead of failing', () => {
    const fake = fakeNamespace(async () => Response.json(video));
    expect(containerProcessor({ ...fake.env, MEDIA_GRANT_SECRET: undefined } as Env)).toBeUndefined();
  });

  it('returns undefined without the MEDIA_CONTAINER binding', () => {
    expect(containerProcessor({ ...env, MEDIA_CONTAINER: undefined } as unknown as Env)).toBeUndefined();
  });
});
