import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { crc32, zipStream } from '../src/download/zip';
import { sanitizeFilename, uniqueName } from '../src/download/routes';
import { expectResponse } from './contract';
import { authHeaders, BASE, uploadAsset } from './helpers';
import { call, setupAssets } from './stream-b';

const dec = new TextDecoder();

/** Minimal reader built on the central directory, the way unzip works. */
function readZip(buf: Uint8Array) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const eocd = buf.length - 22;
  expect(v.getUint32(eocd, true)).toBe(0x06054b50);
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const files: Array<{ name: string; data: Uint8Array; crc: number }> = [];
  for (let i = 0; i < count; i++) {
    expect(v.getUint32(p, true)).toBe(0x02014b50);
    expect(v.getUint16(p + 10, true)).toBe(0); // STORE
    const crc = v.getUint32(p + 16, true);
    const size = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true);
    const offset = v.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    expect(v.getUint32(offset, true)).toBe(0x04034b50);
    expect(v.getUint16(offset + 6, true) & 0x08).toBe(0x08); // data descriptor
    const dataStart = offset + 30 + v.getUint16(offset + 26, true) + v.getUint16(offset + 28, true);
    const data = buf.subarray(dataStart, dataStart + size);
    expect(v.getUint32(dataStart + size, true)).toBe(0x08074b50);
    expect(v.getUint32(dataStart + size + 4, true)).toBe(crc);
    files.push({ name, data, crc });
    p += 46 + nameLen;
  }
  return files;
}

const bodyOf = (bytes: Uint8Array, chunk = 7) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += chunk) c.enqueue(bytes.slice(i, i + chunk));
      c.close();
    },
  });

describe('zip writer', () => {
  it('computes CRC-32 like zlib', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('streams STORE entries with data descriptors and a valid central directory', async () => {
    const a = crypto.getRandomValues(new Uint8Array(1000));
    const b = new Uint8Array(0);
    const files = readZip(
      new Uint8Array(
        await new Response(
          zipStream([
            { name: 'a.bin', modified: new Date('2024-05-04T10:00:00Z'), open: async () => bodyOf(a) },
            { name: 'missing', modified: new Date(), open: async () => null },
            { name: 'ünï.txt', modified: new Date('1970-01-01T00:00:00Z'), open: async () => bodyOf(b) },
          ]),
        ).arrayBuffer(),
      ),
    );
    expect(files.map((f) => f.name)).toEqual(['a.bin', 'ünï.txt']);
    expect(files[0].data).toEqual(a);
    expect(files[0].crc).toBe(crc32(a));
    expect(files[1].data.length).toBe(0);
  });

  it('does not buffer a whole file: the source is pulled as the consumer reads', async () => {
    let pulls = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(c) {
        pulls++;
        if (pulls > 1000) c.close();
        else c.enqueue(new Uint8Array(1024));
      },
    });
    const reader = zipStream([{ name: 'big', modified: new Date(), open: async () => source }]).getReader();
    await reader.read(); // local header
    await reader.read(); // first data chunk
    expect(pulls).toBeLessThan(10);
    await reader.cancel();
  });
});

describe('names', () => {
  it('sanitizes and de-duplicates like Immich', () => {
    expect(sanitizeFilename('a/b\\c:d?.jpg')).toBe('abcd.jpg');
    const used = new Map<string, number>();
    expect([uniqueName('IMG.jpg', used), uniqueName('IMG.jpg', used), uniqueName('IMG.jpg', used), uniqueName('/', used)]).toEqual(['IMG.jpg', 'IMG+1.jpg', 'IMG+2.jpg', 'unnamed']);
  });
});

describe('POST /download/info', () => {
  it('groups assets into archives by archiveSize and adds live photo videos', async () => {
    const { token, ids } = await setupAssets(3); // sizes 100, 101, 102
    const video = (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(50)), { filename: 'clip.mov', fields: { visibility: 'hidden' } })).body.id;
    await env.DB.prepare('UPDATE assets SET live_photo_video_id = ?2 WHERE id = ?1').bind(ids[0], video).run();
    const res = await call(token, 'POST', '/download/info', { assetIds: ids, archiveSize: 150 });
    expect(res.status).toBe(201);
    expectResponse('/download/info', 'post', 201, res.json);
    expect(res.json.totalSize).toBe(100 + 101 + 102 + 50);
    // an archive closes before the asset that would overflow it
    expect(res.json.archives.map((a: any) => a.assetIds)).toEqual([[ids[0]], [ids[1]], [ids[2]], [video]]);
    const all = await call(token, 'POST', '/download/info', { assetIds: ids });
    expect(all.json.archives).toHaveLength(1);
  });

  it('covers the whole timeline for userId, skips trashed and hidden assets', async () => {
    const { token, ids } = await setupAssets(3);
    await call(token, 'DELETE', '/assets', { ids: [ids[0]] });
    await env.DB.prepare("UPDATE assets SET visibility = 'hidden' WHERE id = ?1").bind(ids[1]).run();
    const me = (await call(token, 'GET', '/users/me')).json.id;
    const res = await call(token, 'POST', '/download/info', { userId: me });
    expect(res.json.archives).toEqual([{ assetIds: [ids[2]], size: 102 }]);
  });

  it('is 400 for foreign assets, bad input and missing selectors', async () => {
    const { token, ids, other } = await setupAssets(1, { second: true });
    expect((await call(other, 'POST', '/download/info', { assetIds: ids })).status).toBe(400);
    expect((await call(token, 'POST', '/download/info', {})).status).toBe(400);
    expect((await call(token, 'POST', '/download/info', { assetIds: ['x'] })).status).toBe(400);
    expect((await call(token, 'POST', '/download/info', { assetIds: ids, archiveSize: 0 })).status).toBe(400);
    expect((await call(token, 'POST', '/download/info', { albumId: crypto.randomUUID() })).status).toBe(400);
    expect((await call(other, 'POST', '/download/info', { userId: (await call(token, 'GET', '/users/me')).json.id })).status).toBe(400);
  });
});

describe('POST /download/archive', () => {
  async function seed() {
    const { token, other } = await setupAssets(0, { second: true });
    const contents = [crypto.getRandomValues(new Uint8Array(300)), crypto.getRandomValues(new Uint8Array(400)), crypto.getRandomValues(new Uint8Array(500))];
    const ids: string[] = [];
    for (const [i, bytes] of contents.entries()) ids.push((await uploadAsset(token, bytes, { filename: i === 0 ? 'IMG.JPG' : 'IMG.JPG', fields: { deviceAssetId: `d${i}` } })).body.id);
    return { token, other, ids, contents };
  }

  it('streams a ZIP with the original files, de-duplicated names and a download disposition', async () => {
    const { token, ids, contents } = await seed();
    const res = await SELF.fetch(`${BASE}/api/download/archive`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ assetIds: ids, archiveName: 'My Photos' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''My%20Photos.zip");
    const files = readZip(new Uint8Array(await res.arrayBuffer()));
    expect(files.map((f) => f.name)).toEqual(['IMG.JPG', 'IMG+1.JPG', 'IMG+2.JPG']);
    files.forEach((f, i) => {
      expect(f.data).toEqual(contents[i]);
      expect(f.crc).toBe(crc32(contents[i]));
    });
  });

  it('accepts the form-encoded body the web app posts', async () => {
    const { token, ids, contents } = await seed();
    const res = await SELF.fetch(`${BASE}/api/download/archive`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ assetIds: ids.slice(0, 2).join(',') }).toString(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBeNull();
    const files = readZip(new Uint8Array(await res.arrayBuffer()));
    expect(files.map((f) => f.data)).toEqual([contents[0], contents[1]]);
  });

  it('is 400 for other users assets and bad input, 401 without a token', async () => {
    const { token, ids, other } = await seed();
    const post = (t: string, body: unknown) => call(t, 'POST', '/download/archive', body);
    expect((await post(other, { assetIds: ids })).status).toBe(400);
    expect((await post(token, { assetIds: [...ids, crypto.randomUUID()] })).status).toBe(400);
    expect((await post(token, { assetIds: 'nope' })).status).toBe(400);
    expect((await post(token, {})).status).toBe(400);
    expect((await post('bogus', { assetIds: ids })).status).toBe(401);
  });

  it('refuses an archive over the ZIP size limit before streaming', async () => {
    const { token, ids } = await seed();
    await env.DB.prepare('UPDATE assets SET file_size = 4294967295 WHERE id = ?1').bind(ids[0]).run();
    expect((await call(token, 'POST', '/download/archive', { assetIds: ids })).status).toBe(400);
  });
});
