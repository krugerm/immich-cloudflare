import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { app } from '../src/app';
import { crc32, zipLimits, zipStream } from '../src/download/zip';
import { sanitizeFilename } from '../src/download/routes';
import { authHeaders, uploadAsset } from './helpers';
import { call, setupAssets, sync } from './stream-b';

const row = (id: string) => env.DB.prepare('SELECT * FROM assets WHERE id = ?1').bind(id).first<any>();

/** Calls the app directly so a test can change module-level limits and spy on bindings. */
async function direct(token: string, method: string, path: string, body: unknown) {
  const res = await app.request(`/api${path}`, { method, headers: { ...authHeaders(token), 'content-type': 'application/json' }, body: JSON.stringify(body) }, env);
  return res;
}

async function withLimits<T>(limits: Partial<typeof zipLimits>, fn: () => Promise<T>): Promise<T> {
  const saved = { ...zipLimits };
  Object.assign(zipLimits, limits);
  try {
    return await fn();
  } finally {
    Object.assign(zipLimits, saved);
  }
}

describe('download splitting', () => {
  it('every archive info returns is accepted by archive, with a small ZIP size limit', async () => {
    const { token, ids } = await setupAssets(8); // 100..107 bytes each
    await withLimits({ maxBytes: 3 * 1400 + 22 + 3 * 100, maxEntries: 500 }, async () => {
      const info = await (await direct(token, 'POST', '/download/info', { assetIds: ids })).json<any>();
      expect(info.archives.length).toBeGreaterThan(1);
      for (const a of info.archives) {
        const res = await direct(token, 'POST', '/download/archive', { assetIds: a.assetIds });
        expect(res.status, JSON.stringify(a)).toBe(200);
        expect((await res.arrayBuffer()).byteLength).toBeLessThanOrEqual(zipLimits.maxBytes);
      }
      expect(info.archives.flatMap((a: any) => a.assetIds).sort()).toEqual([...ids].sort());
    });
  });

  it('caps entries per archive at 500 in info and rejects more in archive', async () => {
    const { token, ids } = await setupAssets(1);
    await withLimits({ maxEntries: 3 }, async () => {
      const many = await setupMany(token, 7);
      const info = await (await direct(token, 'POST', '/download/info', { assetIds: many })).json<any>();
      expect(info.archives.map((a: any) => a.assetIds.length)).toEqual([3, 3, 1]);
      expect((await direct(token, 'POST', '/download/archive', { assetIds: many.slice(0, 4) })).status).toBe(400);
      expect((await direct(token, 'POST', '/download/archive', { assetIds: many.slice(0, 3) })).status).toBe(200);
    });
    expect(zipLimits.maxEntries).toBe(500);
    expect(ids).toHaveLength(1);
  });

  it('errors before the 32-bit offset wraps, counting headers and the central directory', async () => {
    const body = () => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(100)); c.close(); } });
    const entries = [{ name: 'a', modified: new Date(), open: async () => body() }];
    const size = async (max: number) => withLimits({ maxBytes: max }, () => new Response(zipStream(entries)).arrayBuffer());
    const total = (await size(0xffffffff)).byteLength;
    expect(crc32(new Uint8Array(0))).toBe(0);
    await expect(size(total - 1)).rejects.toThrow();
    expect((await size(total)).byteLength).toBe(total);
  });

  it('truncates filenames on code points', () => {
    const name = sanitizeFilename('😀'.repeat(200));
    expect(name.length).toBeLessThanOrEqual(255);
    expect([...name].every((c) => c === '😀')).toBe(true);
  });
});

async function setupMany(token: string, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push((await uploadAsset(token, crypto.getRandomValues(new Uint8Array(30 + i)), { filename: `M${i}.JPG`, fields: { deviceAssetId: `m${i}` } })).body.id);
  return ids;
}

describe('locked assets are treated as missing', () => {
  it('download, update, trash and metadata return 400 and download info skips them', async () => {
    const { token, ids } = await setupAssets(2);
    await env.DB.prepare("UPDATE assets SET visibility = 'locked' WHERE id = ?1").bind(ids[0]).run();
    const before = JSON.stringify(await row(ids[0]));
    expect((await call(token, 'POST', '/download/archive', { assetIds: [ids[0]] })).status).toBe(400);
    expect((await call(token, 'POST', '/download/info', { assetIds: [ids[0]] })).status).toBe(400);
    expect((await call(token, 'PUT', `/assets/${ids[0]}`, { isFavorite: true })).status).toBe(400);
    expect((await call(token, 'PUT', '/assets', { ids: ids, isFavorite: true })).status).toBe(400);
    expect((await call(token, 'DELETE', '/assets', { ids: [ids[0]], force: true })).status).toBe(400);
    expect((await call(token, 'POST', '/trash/restore/assets', { ids: [ids[0]] })).status).toBe(400);
    expect((await call(token, 'GET', `/assets/${ids[0]}/metadata`)).status).toBe(400);
    expect((await call(token, 'PUT', `/assets/${ids[0]}/metadata`, { items: [{ key: 'k', value: {} }] })).status).toBe(400);
    const me = (await call(token, 'GET', '/users/me')).json.id;
    expect((await call(token, 'POST', '/download/info', { userId: me })).json.archives).toEqual([{ assetIds: [ids[1]], size: 101 }]);
    // restore-all and empty leave a locked trashed asset alone
    await env.DB.prepare("UPDATE assets SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1").bind(ids[0]).run();
    const trashed = JSON.stringify(await row(ids[0]));
    await call(token, 'POST', '/trash/restore');
    await call(token, 'POST', '/trash/empty');
    expect(JSON.stringify(await row(ids[0]))).toBe(trashed);
    expect(before).not.toBe(trashed);
  });
});

describe('POST /assets/jobs queueing', () => {
  it('sends in chunks of 100 and caps ids at 1000', async () => {
    const { token, ids } = await setupAssets(3);
    const spy = vi.spyOn(env.PROCESS_QUEUE, 'sendBatch').mockResolvedValue(undefined as never);
    try {
      expect((await direct(token, 'POST', '/assets/jobs', { assetIds: ids, name: 'refresh-metadata' })).status).toBe(204);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toHaveLength(3);
      const tooMany = Array.from({ length: 1001 }, () => crypto.randomUUID());
      expect((await direct(token, 'POST', '/assets/jobs', { assetIds: tooMany, name: 'refresh-metadata' })).status).toBe(400);
    } finally {
      spy.mockRestore();
    }
  });

  it('returns 500 and leaves status untouched when the queue send fails', async () => {
    const { token, ids } = await setupAssets(2);
    await env.DB.prepare("UPDATE assets SET status = 'ready'").run();
    const before = await Promise.all(ids.map(row));
    const spy = vi.spyOn(env.PROCESS_QUEUE, 'sendBatch').mockRejectedValue(new Error('queue down'));
    try {
      expect((await direct(token, 'POST', '/assets/jobs', { assetIds: ids, name: 'regenerate-thumbnail' })).status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    const after = await Promise.all(ids.map(row));
    expect(after.map((a) => [a.status, a.update_id])).toEqual(before.map((a) => [a.status, a.update_id]));
  });
});

describe('force-deleting a linked motion video', () => {
  it('unlinks each referencing still with its own tracked statement', async () => {
    const { token, ids } = await setupAssets(2);
    const video = (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(60)), { filename: 'clip.mov', fields: { visibility: 'hidden' } })).body.id;
    await env.DB.prepare('UPDATE assets SET live_photo_video_id = ?1').bind(video).run();
    // the video row itself is also matched by the blanket update above; clear it
    await env.DB.prepare('UPDATE assets SET live_photo_video_id = NULL WHERE id = ?1').bind(video).run();
    const before = await Promise.all(ids.map(row));
    expect((await call(token, 'DELETE', '/assets', { ids: [video], force: true })).status).toBe(204);
    expect(await row(video)).toBeNull();
    const after = await Promise.all(ids.map(row));
    expect(after.every((a) => a.live_photo_video_id === null)).toBe(true);
    expect(new Set(after.map((a) => a.update_id)).size).toBe(2);
    after.forEach((a, i) => expect(a.update_id > before[i].update_id).toBe(true));
    const lines = await sync(token, ['AssetsV2']);
    expect(lines.filter((l) => l.type === 'AssetV2' && ids.includes(l.data.id)).every((l) => l.data.livePhotoVideoId === null)).toBe(true);
  });
});
