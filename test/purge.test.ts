import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { AssetRow } from '../src/db/rows';
import { cleanupLoginFailures, purgeAssets, purgeTrash } from '../src/cron/purge';
import { authHeaders, BASE, createUser, login, uploadAsset } from './helpers';

describe('purgeTrash', () => {
  it('hard-deletes assets trashed over 30 days ago, writes audits, keeps the rest', async () => {
    await createUser();
    const token = await login();
    const old = (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(100)))).body.id;
    const recent = (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(101)))).body.id;
    const live = (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(102)))).body.id;
    await env.MEDIA.put(`thumbs/${old}/thumbnail.webp`, 'x');
    await env.MEDIA.put(`thumbs/${old}/preview.jpeg`, 'x');
    await env.DB.prepare("UPDATE assets SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1").bind(old).run();
    await env.DB.prepare("UPDATE assets SET deleted_at = '2026-03-01T00:00:00.000Z' WHERE id = ?1").bind(recent).run();
    const oldPath = await env.DB.prepare('SELECT original_path FROM assets WHERE id = ?1').bind(old).first<string>('original_path');

    expect(await purgeTrash(env, new Date('2026-03-15T00:00:00.000Z'))).toBe(1);

    const remaining = (await env.DB.prepare('SELECT id FROM assets ORDER BY id').all<{ id: string }>()).results.map((r) => r.id);
    expect(remaining.sort()).toEqual([recent, live].sort());
    expect(await env.MEDIA.head(oldPath!)).toBeNull();
    expect(await env.MEDIA.head(`thumbs/${old}/thumbnail.webp`)).toBeNull();
    expect((await env.MEDIA.list({ prefix: `thumbs/${old}/` })).objects).toHaveLength(0);
    const audit = await env.DB.prepare('SELECT asset_id FROM asset_audit').all<{ asset_id: string }>();
    expect(audit.results).toEqual([{ asset_id: old }]);
    expect(await env.DB.prepare('SELECT usage_bytes FROM users').first('usage_bytes')).toBe(101 + 102);
  });

  it('deletes login_failures older than 15 minutes', async () => {
    const now = new Date('2026-03-15T12:00:00.000Z');
    const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();
    await env.DB.prepare('INSERT INTO login_failures (email, failures, window_start) VALUES (?1, 3, ?2), (?3, 1, ?4)')
      .bind('old@example.com', at(16), 'fresh@example.com', at(5))
      .run();
    await cleanupLoginFailures(env.DB, now);
    const rows = await env.DB.prepare('SELECT email FROM login_failures').all<{ email: string }>();
    expect(rows.results).toEqual([{ email: 'fresh@example.com' }]);
  });

  it('bounds each run and continues on the next', async () => {
    await createUser();
    const token = await login();
    for (let i = 0; i < 5; i++) {
      const id = (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(100 + i)))).body.id;
      await env.DB.prepare("UPDATE assets SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1").bind(id).run();
    }
    const now = new Date('2026-03-15T00:00:00.000Z');
    expect(await purgeTrash(env, now, { maxPerRun: 3, batch: 2 })).toBe(3);
    expect(await purgeTrash(env, now, { maxPerRun: 3, batch: 2 })).toBe(2);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM assets').first('n')).toBe(0);
  });

  it('purges a linked live-photo video with its still', async () => {
    await createUser();
    const token = await login();
    const still = (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(100)))).body.id;
    const video = (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(101)))).body.id;
    await env.DB.prepare("UPDATE assets SET deleted_at = '2026-01-01T00:00:00.000Z', live_photo_video_id = ?2 WHERE id = ?1").bind(still, video).run();
    const paths = (await env.DB.prepare('SELECT original_path FROM assets').all<{ original_path: string }>()).results.map((r) => r.original_path);
    expect(await purgeTrash(env, new Date('2026-03-15T00:00:00.000Z'))).toBe(1);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM assets').first('n')).toBe(0);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM asset_audit').first('n')).toBe(2);
    for (const p of paths) expect(await env.MEDIA.head(p)).toBeNull();
    expect(await env.DB.prepare('SELECT usage_bytes FROM users').first('usage_bytes')).toBe(0);
  });

  it('keeps a linked video that another live asset still references', async () => {
    await createUser();
    const token = await login();
    const a = (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(100)))).body.id;
    const b = (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(101)))).body.id;
    const video = (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(102)))).body.id;
    await env.DB.prepare("UPDATE assets SET deleted_at = '2026-01-01T00:00:00.000Z', live_photo_video_id = ?2 WHERE id = ?1").bind(a, video).run();
    await env.DB.prepare('UPDATE assets SET live_photo_video_id = ?2 WHERE id = ?1').bind(b, video).run();
    await purgeTrash(env, new Date('2026-03-15T00:00:00.000Z'));
    const ids = (await env.DB.prepare('SELECT id FROM assets').all<{ id: string }>()).results.map((r) => r.id);
    expect(ids.sort()).toEqual([b, video].sort());
  });

  it('is idempotent when the same batch is purged twice', async () => {
    await createUser();
    const token = await login();
    const id = (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(100)))).body.id;
    await uploadAsset(token, crypto.getRandomValues(new Uint8Array(50)));
    await env.DB.prepare("UPDATE assets SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1").bind(id).run();
    const rows = [(await env.DB.prepare('SELECT * FROM assets WHERE id = ?1').bind(id).first<AssetRow>())!];
    const now = new Date('2026-03-15T00:00:00.000Z');
    await purgeAssets(env, rows, now);
    await purgeAssets(env, rows, now);
    expect(await env.DB.prepare('SELECT usage_bytes FROM users').first('usage_bytes')).toBe(50);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM asset_audit').first('n')).toBe(1);
  });
});

describe('purge racing a restore', () => {
  const now = new Date('2026-03-15T00:00:00.000Z');
  const rowOf = async (id: string) => (await env.DB.prepare('SELECT * FROM assets WHERE id = ?1').bind(id).first<AssetRow>())!;

  it('leaves an asset restored after the purge read it: row, original, usage, audits, album and memory links', async () => {
    await createUser();
    const token = await login();
    const id = (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(100)))).body.id;
    const post = (path: string, body: unknown) =>
      SELF.fetch(`${BASE}/api${path}`, { method: 'POST', headers: { ...authHeaders(token), 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post('/albums', { albumName: 'A', assetIds: [id] })).status).toBe(201);
    expect((await post('/memories', { type: 'on_this_day', data: { year: 2020 }, memoryAt: now.toISOString(), assetIds: [id] })).status).toBe(201);
    await env.DB.prepare("UPDATE assets SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1").bind(id).run();
    const stale = await rowOf(id);
    await env.DB.prepare('UPDATE assets SET deleted_at = NULL WHERE id = ?1').bind(id).run(); // the restore lands

    await purgeAssets(env, [stale], now);

    expect(await env.DB.prepare('SELECT id FROM assets WHERE id = ?1').bind(id).first('id')).toBe(id);
    expect(await env.MEDIA.head(stale.original_path)).not.toBeNull();
    expect(await env.DB.prepare('SELECT usage_bytes FROM users').first('usage_bytes')).toBe(100);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM asset_audit').first('n')).toBe(0);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM album_assets').first('n')).toBe(1);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM album_asset_audit').first('n')).toBe(0);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM memory_asset_audit').first('n')).toBe(0);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM r2_delete_queue').first('n')).toBe(0);
  });

  it('keeps the linked video of a still restored after the purge read it', async () => {
    await createUser();
    const token = await login();
    const still = (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(100)))).body.id;
    const video = (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(101)))).body.id;
    await env.DB.prepare("UPDATE assets SET deleted_at = '2026-01-01T00:00:00.000Z', live_photo_video_id = ?2 WHERE id = ?1").bind(still, video).run();
    const stale = await rowOf(still);
    const videoPath = (await rowOf(video)).original_path;
    await env.DB.prepare('UPDATE assets SET deleted_at = NULL WHERE id = ?1').bind(still).run();

    await purgeAssets(env, [stale], now);

    expect(await env.DB.prepare('SELECT count(*) AS n FROM assets').first('n')).toBe(2);
    expect(await env.MEDIA.head(videoPath)).not.toBeNull();
    expect(await env.DB.prepare('SELECT count(*) AS n FROM asset_audit').first('n')).toBe(0);
    expect(await env.DB.prepare('SELECT usage_bytes FROM users').first('usage_bytes')).toBe(201);
  });

  it('retries R2 deletes that failed after the commit on the next run', async () => {
    await createUser();
    const token = await login();
    const id = (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(100)))).body.id;
    await env.MEDIA.put(`thumbs/${id}/preview.jpeg`, 'x');
    await env.DB.prepare("UPDATE assets SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1").bind(id).run();
    const path = (await rowOf(id)).original_path;
    const failing = {
      ...env,
      MEDIA: Object.assign(Object.create(env.MEDIA), { delete: () => Promise.reject(new Error('R2 down')) }),
    } as typeof env;

    await expect(purgeTrash(failing, now)).rejects.toThrow('R2 down');
    expect(await env.DB.prepare('SELECT count(*) AS n FROM assets').first('n')).toBe(0);
    expect(await env.MEDIA.head(path)).not.toBeNull();
    expect(await env.DB.prepare('SELECT count(*) AS n FROM r2_delete_queue').first('n')).toBe(5); // original, 2 thumbs, 2 derived

    expect(await purgeTrash(env, now)).toBe(0);
    expect(await env.MEDIA.head(path)).toBeNull();
    expect(await env.MEDIA.head(`thumbs/${id}/preview.jpeg`)).toBeNull();
    expect(await env.DB.prepare('SELECT count(*) AS n FROM r2_delete_queue').first('n')).toBe(0);
  });
});
