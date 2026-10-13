import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { copyToBackup, handleBackupBatch, requeueMissingBackups, type BackupMessage } from '../src/backup/consumer';
import type { AssetRow } from '../src/db/rows';
import { createUser, login, uploadAsset } from './helpers';

describe('backup', () => {
  async function upload(bytes: Uint8Array) {
    await createUser();
    const token = await login();
    const id = (await uploadAsset(token, bytes)).body.id;
    const asset = (await env.DB.prepare('SELECT * FROM assets WHERE id = ?1').bind(id).first<AssetRow>())!;
    return { id, asset };
  }
  const backedUpAt = (id: string) => env.DB.prepare('SELECT backed_up_at FROM assets WHERE id = ?1').bind(id).first('backed_up_at');
  const sha1B64 = async (buf: ArrayBuffer) =>
    btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-1', buf))));

  it('copies the original into BACKUP byte-for-byte with metadata and stamps backed_up_at', async () => {
    const bytes = crypto.getRandomValues(new Uint8Array(100));
    const { id, asset } = await upload(bytes);
    const srcType = (await env.MEDIA.head(asset.original_path))!.httpMetadata?.contentType;
    await copyToBackup(env, asset);
    const copy = (await env.BACKUP.get(asset.original_path))!;
    expect(new Uint8Array(await copy.arrayBuffer())).toEqual(bytes);
    expect(copy.httpMetadata?.contentType).toBe(srcType);
    expect(copy.customMetadata?.sha1).toBe(asset.checksum);
    expect(await backedUpAt(id)).toBeTruthy();
    expect(await env.MEDIA.head(asset.original_path)).not.toBeNull();
  });

  it('copies a multi-part-sized original and both copies hash to the checksum', async () => {
    const bytes = new Uint8Array(11 * 1024 * 1024 + 123);
    for (let i = 0; i < bytes.length; i += 65536) crypto.getRandomValues(bytes.subarray(i, Math.min(i + 65536, bytes.length)));
    const { id, asset } = await upload(bytes);
    await copyToBackup(env, asset);
    const src = await (await env.MEDIA.get(asset.original_path))!.arrayBuffer();
    const dst = await (await env.BACKUP.get(asset.original_path))!.arrayBuffer();
    expect(dst.byteLength).toBe(bytes.length);
    expect(await sha1B64(src)).toBe(asset.checksum);
    expect(await sha1B64(dst)).toBe(asset.checksum);
    expect(await backedUpAt(id)).toBeTruthy();
  });

  it('throws when the source is missing and leaves backed_up_at null', async () => {
    const { id, asset } = await upload(crypto.getRandomValues(new Uint8Array(100)));
    await env.MEDIA.delete(asset.original_path);
    await expect(copyToBackup(env, asset)).rejects.toThrow(`backup source missing: ${asset.original_path}`);
    expect(await backedUpAt(id)).toBeNull();
    expect(await env.BACKUP.head(asset.original_path)).toBeNull();
  });

  const batchOf = (assetId: string) => {
    const calls = { acked: 0, retried: 0 };
    const batch = { messages: [{ body: { assetId }, ack: () => calls.acked++, retry: () => calls.retried++ }] } as unknown as MessageBatch<BackupMessage>;
    return { batch, calls };
  };

  it('handleBackupBatch skips an already backed-up asset without a put', async () => {
    const { id, asset } = await upload(crypto.getRandomValues(new Uint8Array(100)));
    await env.DB.prepare("UPDATE assets SET backed_up_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1").bind(id).run();
    const { batch, calls } = batchOf(id);
    await handleBackupBatch(batch, env);
    expect(calls).toEqual({ acked: 1, retried: 0 });
    expect(await env.BACKUP.head(asset.original_path)).toBeNull();
  });

  it('handleBackupBatch copies, acks, and retries on error', async () => {
    const { id, asset } = await upload(crypto.getRandomValues(new Uint8Array(100)));
    const ok = batchOf(id);
    await handleBackupBatch(ok.batch, env);
    expect(ok.calls).toEqual({ acked: 1, retried: 0 });
    expect(await env.BACKUP.head(asset.original_path)).not.toBeNull();

    await env.DB.prepare('UPDATE assets SET backed_up_at = NULL WHERE id = ?1').bind(id).run();
    await env.MEDIA.delete(asset.original_path);
    const bad = batchOf(id);
    await handleBackupBatch(bad.batch, env);
    expect(bad.calls).toEqual({ acked: 0, retried: 1 });
  });

  it('re-enqueues only processed assets without a backup', async () => {
    await createUser();
    const token = await login();
    const a = (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(100)))).body.id;
    const b = (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(101)))).body.id;
    await uploadAsset(token, crypto.getRandomValues(new Uint8Array(102))); // stays pending
    await env.DB.prepare("UPDATE assets SET status = 'ready' WHERE id IN (?1, ?2)").bind(a, b).run();
    await env.DB.prepare("UPDATE assets SET backed_up_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1").bind(b).run();
    expect(await requeueMissingBackups(env)).toBe(1);
  });
});
