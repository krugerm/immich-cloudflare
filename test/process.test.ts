import { env, SELF } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { encode } from 'fast-png';
import worker from '../src/index';
import { handleProcessBatch, handleProcessDeadLetters, PROCESS_MAX_RETRIES, processAsset } from '../src/process/consumer';
import type { Thumbnailer } from '../src/process/thumbs';
import { authHeaders, BASE, createUser, login, uploadAsset } from './helpers';
import sampleJpg from './fixtures/media/sample.jpg?arraybuffer';
import noExifPng from './fixtures/media/no-exif.png?arraybuffer';

/** Fake Images binding: returns a 4x3 solid PNG for every render, records calls. */
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

async function uploaded(filename = 'IMG_0001.JPG', bytes = new Uint8Array(sampleJpg)) {
  await createUser();
  const token = await login();
  return (await uploadAsset(token, bytes, { filename })).body.id;
}

describe('processAsset', () => {
  it('writes thumbnails, thumbhash, exif and marks ready with new cursors', async () => {
    const id = await uploaded();
    const before = await env.DB.prepare('SELECT update_id FROM assets WHERE id = ?1').bind(id).first<string>('update_id');
    const t = fakeThumbnailer();
    await processAsset(env, id, t);
    expect(t.calls).toEqual([
      { height: 1440, format: 'image/jpeg' }, // 4x3: the short side is the height
      { height: 250, format: 'image/webp' },
      { width: 100, height: 100, format: 'image/png' },
    ]);
    const a = await env.DB.prepare('SELECT * FROM assets WHERE id = ?1').bind(id).first<any>();
    expect(a.status).toBe('ready');
    expect(a.has_thumbnail).toBe(1);
    expect(a.thumbhash).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(a.update_id > before!).toBe(true);
    expect(await env.MEDIA.head(`thumbs/${id}/thumbnail.webp`)).not.toBeNull();
    expect(await env.MEDIA.head(`thumbs/${id}/preview.jpeg`)).not.toBeNull();
    const exif = await env.DB.prepare('SELECT * FROM asset_exif WHERE asset_id = ?1').bind(id).first<any>();
    expect(exif.make).toBeTruthy();
    expect(exif.file_size_in_byte).toBe(a.file_size);
    expect(a.local_date_time).not.toBe(a.file_created_at); // taken from EXIF, not the upload field
  });

  it('stores the file mtime as modify_date, not the EXIF ModifyDate', async () => {
    const id = await uploaded();
    await processAsset(env, id, fakeThumbnailer());
    const a = await env.DB.prepare('SELECT * FROM assets WHERE id = ?1').bind(id).first<any>();
    const exif = await env.DB.prepare('SELECT * FROM asset_exif WHERE asset_id = ?1').bind(id).first<any>();
    expect(exif.modify_date).toBe(a.file_modified_at);
    expect(exif.modify_date).not.toBe('2008-11-01T21:15:07.000Z'); // sample.jpg's EXIF ModifyDate
  });

  it('falls back to the file creation time without EXIF dates and stores an empty description', async () => {
    const id = await uploaded('plain.png', new Uint8Array(noExifPng));
    await processAsset(env, id, fakeThumbnailer());
    const a = await env.DB.prepare('SELECT * FROM assets WHERE id = ?1').bind(id).first<any>();
    const exif = await env.DB.prepare('SELECT * FROM asset_exif WHERE asset_id = ?1').bind(id).first<any>();
    expect(exif.date_time_original).toBe(a.file_created_at);
    expect(exif.description).toBe('');
  });

  it('is idempotent when the same message is delivered twice', async () => {
    const id = await uploaded();
    await processAsset(env, id, fakeThumbnailer());
    const cursor = () => env.DB.prepare('SELECT update_id FROM assets WHERE id = ?1').bind(id).first<string>('update_id');
    const first = await cursor();
    const second = fakeThumbnailer();
    await processAsset(env, id, second);
    expect(second.calls).toEqual([]);
    expect(await cursor()).toBe(first);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM asset_exif').first('n')).toBe(1);
  });

  it('a transient error rejects and leaves the asset pending', async () => {
    const id = await uploaded();
    await expect(processAsset(env, id, fakeThumbnailer(new Error('network')))).rejects.toThrow('network');
    expect(await env.DB.prepare('SELECT status FROM assets WHERE id = ?1').bind(id).first('status')).toBe('pending');
  });

  it('falls back to Images dimensions when EXIF has none', async () => {
    const id = await uploaded('plain.png', new Uint8Array(noExifPng));
    const t = fakeThumbnailer(false, { width: 16, height: 16 });
    await processAsset(env, id, t);
    const a = await env.DB.prepare('SELECT status, width, height FROM assets WHERE id = ?1').bind(id).first<any>();
    expect(a).toEqual({ status: 'ready', width: 16, height: 16 });
    expect(t.calls[0]).toEqual({ width: 1440, format: 'image/jpeg' }); // square: width
  });

  it('unsupported input marks needs_media and writes no thumbnails', async () => {
    const id = await uploaded('clip.mov', crypto.getRandomValues(new Uint8Array(2048)));
    await processAsset(env, id, fakeThumbnailer());
    const a = await env.DB.prepare('SELECT status, has_thumbnail, local_date_time, file_created_at FROM assets WHERE id = ?1').bind(id).first<any>();
    expect(a.status).toBe('needs_media');
    expect(a.has_thumbnail).toBe(0);
    expect(a.local_date_time).toBe(a.file_created_at);
    expect(await env.MEDIA.head(`thumbs/${id}/thumbnail.webp`)).toBeNull();
  });

  it('a rendering failure marks failed with the error and does not throw', async () => {
    const id = await uploaded();
    await processAsset(env, id, fakeThumbnailer(true));
    const a = await env.DB.prepare('SELECT status, error FROM assets WHERE id = ?1').bind(id).first<any>();
    expect(a.status).toBe('failed');
    expect(a.error).toContain('9412');
  });

  it('enqueues a backup for needs_media and terminal failed assets, and survives send failures', async () => {
    const send = vi.spyOn(env.BACKUP_QUEUE, 'send').mockResolvedValue(undefined as never);
    const video = await uploaded('clip.mov', crypto.getRandomValues(new Uint8Array(2048)));
    await processAsset(env, video, fakeThumbnailer());
    expect(send).toHaveBeenCalledWith({ assetId: video });
    const image = (await uploadAsset(await login(), crypto.getRandomValues(new Uint8Array(3000)), { filename: 'b.jpg' })).body.id;
    await processAsset(env, image, fakeThumbnailer(true));
    expect(send).toHaveBeenCalledWith({ assetId: image });
    expect(send).toHaveBeenCalledTimes(2);
    send.mockRejectedValue(new Error('queue down'));
    const other = (await uploadAsset(await login(), crypto.getRandomValues(new Uint8Array(2048)), { filename: 'c.mov' })).body.id;
    await expect(processAsset(env, other, fakeThumbnailer())).resolves.toBeUndefined();
    expect(await env.DB.prepare('SELECT status FROM assets WHERE id = ?1').bind(other).first('status')).toBe('needs_media');
    send.mockRestore();
  });

  it('ignores a message for a deleted asset', async () => {
    await createUser();
    await expect(processAsset(env, crypto.randomUUID(), fakeThumbnailer())).resolves.toBeUndefined();
  });
});

describe('reprocess-failed', () => {
  it('re-enqueues failed assets for admins only', async () => {
    const id = await uploaded();
    await processAsset(env, id, fakeThumbnailer(true));
    const token = await login();
    const res = await SELF.fetch(`${BASE}/api/admin-cf/reprocess-failed`, { method: 'POST', headers: authHeaders(token) });
    expect(await res.json()).toEqual({ queued: 1 });
    await createUser({ email: 'kid@example.com', isAdmin: false });
    const other = await login('kid@example.com');
    const denied = await SELF.fetch(`${BASE}/api/admin-cf/reprocess-failed`, { method: 'POST', headers: authHeaders(other) });
    expect(denied.status).toBe(403);
  });
});

describe('dead letters and routing', () => {
  const fakeBatch = (queue: string, ids: string[]) => {
    const acked: string[] = [];
    const batch = {
      queue,
      messages: ids.map((assetId) => ({ body: { assetId }, ack: () => acked.push(assetId), retry() {} })),
      retried: false,
      retryAll() { this.retried = true; },
      ackAll() {},
    };
    return { batch: batch as unknown as MessageBatch<{ assetId: string }> & { retried: boolean }, acked };
  };

  it('marks a pending asset failed and leaves a ready one alone', async () => {
    const pending = await uploaded();
    const readyId = (await uploadAsset(await login(), new Uint8Array(noExifPng), { filename: 'b.png' })).body.id;
    await processAsset(env, readyId, fakeThumbnailer());
    const { batch, acked } = fakeBatch('asset-process-dlq', [pending, readyId]);
    await handleProcessDeadLetters(batch, env);
    const status = (id: string) => env.DB.prepare('SELECT status FROM assets WHERE id = ?1').bind(id).first('status');
    expect(await status(pending)).toBe('failed');
    expect(await status(readyId)).toBe('ready');
    expect(acked).toEqual([pending, readyId]);
  });

  it('retries a dead-letter message when D1 throws and acks the rest', async () => {
    const id = await uploaded();
    const retried: string[] = [];
    const acked: string[] = [];
    const msg = (assetId: string) => ({ body: { assetId }, ack: () => acked.push(assetId), retry: () => retried.push(assetId) });
    const batch = { queue: 'asset-process-dlq', messages: [msg(id), msg('other')] } as unknown as MessageBatch<{ assetId: string }>;
    const spy = vi.spyOn(env.DB, 'batch').mockRejectedValueOnce(new Error('D1 down'));
    await handleProcessDeadLetters(batch, env);
    spy.mockRestore();
    expect(retried).toEqual([id]);
    expect(acked).toEqual(['other']);
  });

  it('marks an asset failed on its last delivery without a dead-letter queue, and retries earlier ones', async () => {
    const id = await uploaded();
    const outcome: string[] = [];
    const delivery = (attempts: number) => ({ body: { assetId: id }, attempts, ack: () => outcome.push(`ack@${attempts}`), retry: () => outcome.push(`retry@${attempts}`) });
    const transient = fakeThumbnailer(new Error('Images binding unavailable')); // not an input error: the queue retries
    const status = () => env.DB.prepare('SELECT status FROM assets WHERE id = ?1').bind(id).first('status');
    const run = (attempts: number) =>
      handleProcessBatch({ queue: 'asset-process', messages: [delivery(attempts)] } as unknown as MessageBatch<{ assetId: string }>, env, transient);
    await run(PROCESS_MAX_RETRIES);
    expect(await status()).toBe('pending');
    await run(PROCESS_MAX_RETRIES + 1);
    expect(await status()).toBe('failed');
    expect(outcome).toEqual([`retry@${PROCESS_MAX_RETRIES}`, `ack@${PROCESS_MAX_RETRIES + 1}`]);
  });

  it('retries messages from unknown queues', async () => {
    const { batch } = fakeBatch('some-other-queue', ['x']);
    await worker.queue!(batch as any, { ...env, DISABLE_QUEUE_CONSUMERS: undefined } as any);
    expect(batch.retried).toBe(true);
  });

  it('routes asset-backup to the backup handler', async () => {
    const { batch, acked } = fakeBatch('asset-backup', ['missing-asset']);
    await worker.queue!(batch as any, { ...env, DISABLE_QUEUE_CONSUMERS: undefined } as any);
    expect(acked).toEqual(['missing-asset']);
    expect(batch.retried).toBe(false);
  });
});
