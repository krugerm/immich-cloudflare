import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { toBase64, writeToR2 } from '../src/upload/r2-writer';

function streamOf(bytes: Uint8Array, size = 65536, failAt?: number): ReadableStream<Uint8Array> {
  let o = 0;
  return new ReadableStream({
    pull(c) {
      if (failAt !== undefined && o >= failAt) return c.error(new Error('client went away'));
      if (o >= bytes.length) return c.close();
      c.enqueue(bytes.slice(o, o + size));
      o += size;
    },
  });
}

async function sha1(bytes: Uint8Array) {
  return toBase64(new Uint8Array(await crypto.subtle.digest('SHA-1', bytes)));
}

describe('writeToR2', () => {
  it('writes a small file with put and returns size and SHA-1', async () => {
    const data = crypto.getRandomValues(new Uint8Array(1000));
    const r = await writeToR2(env.MEDIA, 'k/small', streamOf(data), { contentType: 'image/jpeg' });
    expect(r.size).toBe(1000);
    expect(toBase64(r.sha1)).toBe(await sha1(data));
    expect(new Uint8Array(await (await env.MEDIA.get('k/small'))!.arrayBuffer())).toEqual(data);
  });

  it('writes a multi-part file with equal parts and a short last part', async () => {
    const data = new Uint8Array(5 * 1024 * 1024 * 2 + 12345).map((_, i) => i % 251);
    const r = await writeToR2(env.MEDIA, 'k/big', streamOf(data), { contentType: 'video/quicktime', partSize: 5 * 1024 * 1024 });
    expect(r.size).toBe(data.length);
    expect(toBase64(r.sha1)).toBe(await sha1(data));
    const obj = await env.MEDIA.get('k/big');
    expect(obj!.size).toBe(data.length);
    expect(obj!.httpMetadata?.contentType).toBe('video/quicktime');
  });

  it('aborts and leaves no object when the stream errors', async () => {
    const data = new Uint8Array(12 * 1024 * 1024);
    await expect(
      writeToR2(env.MEDIA, 'k/broken', streamOf(data, 65536, 6 * 1024 * 1024), { contentType: 'video/mp4', partSize: 5 * 1024 * 1024 }),
    ).rejects.toThrow('client went away');
    expect(await env.MEDIA.head('k/broken')).toBeNull();
  });
});

describe('writeToR2 allocation', () => {
  const MiB = 1024 * 1024;
  function fakeBucket() {
    const puts: Uint8Array[] = [];
    const parts: Uint8Array[] = [];
    const bucket = {
      put: async (_k: string, v: Uint8Array) => void puts.push(v),
      createMultipartUpload: async () => ({
        uploadPart: async (n: number, v: Uint8Array) => (parts.push(v), { partNumber: n, etag: 'e' }),
        complete: async () => ({}),
        abort: async () => {},
      }),
    } as unknown as R2Bucket;
    return { bucket, puts, parts };
  }

  it('does not allocate more than sizeHint for a small file (observed via the backing buffer handed to put)', async () => {
    const { bucket, puts } = fakeBucket();
    await writeToR2(bucket, 'k', streamOf(new Uint8Array(1024)), { contentType: 'x', sizeHint: 2048 });
    expect(puts).toHaveLength(1);
    expect(puts[0].length).toBe(1024);
    expect(puts[0].buffer.byteLength).toBe(2048);
  });

  it('grows the buffer when the hint underestimates the stream', async () => {
    const { bucket, puts } = fakeBucket();
    const data = crypto.getRandomValues(new Uint8Array(5000));
    await writeToR2(bucket, 'k', streamOf(data, 700), { contentType: 'x', sizeHint: 1000 });
    expect(puts[0]).toEqual(data);
  });

  it('reuses one part buffer across parts', async () => {
    const { bucket, parts } = fakeBucket();
    const data = new Uint8Array(5 * MiB * 2 + 10).map((_, i) => i % 13);
    await writeToR2(bucket, 'k', streamOf(data, 1 * MiB), { contentType: 'x', partSize: 5 * MiB, sizeHint: data.length });
    expect(parts.map((p) => p.length)).toEqual([5 * MiB, 5 * MiB, 10]);
    expect(new Set(parts.map((p) => p.buffer)).size).toBe(1);
    expect(parts[0].buffer.byteLength).toBe(5 * MiB);
  });

  it('rejects a partSize below the R2 minimum', async () => {
    const { bucket } = fakeBucket();
    await expect(writeToR2(bucket, 'k', streamOf(new Uint8Array(10)), { contentType: 'x', partSize: 1 * MiB })).rejects.toThrow(/partSize/);
  });
});
