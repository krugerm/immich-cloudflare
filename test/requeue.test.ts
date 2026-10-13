import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { requeueStalePending } from '../src/cron/index';
import { createUser, login, uploadAsset } from './helpers';

describe('requeueStalePending', () => {
  it('enqueues pending assets older than an hour and nothing else', async () => {
    await createUser();
    const token = await login();
    const up = async () => (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(100)))).body.id;
    const stale = await up();
    const staleReady = await up();
    const staleTrashed = await up();
    const fresh = await up();
    const set = (id: string, sql: string) => env.DB.prepare(`UPDATE assets SET ${sql} WHERE id = ?1`).bind(id).run();
    for (const id of [stale, staleReady, staleTrashed]) await set(id, "created_at = '2026-01-01T00:00:00.000Z'");
    await set(staleReady, "status = 'ready'");
    await set(staleTrashed, "deleted_at = '2026-01-02T00:00:00.000Z'");
    await set(fresh, "created_at = '2026-01-01T00:30:00.000Z'");

    const send = vi.spyOn(env.PROCESS_QUEUE, 'sendBatch').mockResolvedValue(undefined as never);
    const n = await requeueStalePending(env, new Date('2026-01-01T01:00:01.000Z'));
    expect(n).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toEqual([{ body: { assetId: stale } }]);
    send.mockRestore();
  });

  it('sends in chunks of 100', async () => {
    await createUser();
    const token = await login();
    const { id: ownerId } = (await env.DB.prepare('SELECT id FROM users').first<{ id: string }>())!;
    void token;
    const stmts = Array.from({ length: 250 }, (_, i) =>
      env.DB.prepare(
        `INSERT INTO assets (id, owner_id, device_asset_id, device_id, type, original_path, original_file_name, checksum, file_created_at, file_modified_at, local_date_time, file_size, created_at, updated_at, update_id)
         VALUES (?1, ?2, ?1, 'd', 'IMAGE', 'p', 'f', ?1, 'x', 'x', 'x', 1, '2026-01-01T00:00:00.000Z', 'x', ?1)`,
      ).bind(`a${String(i).padStart(3, '0')}`, ownerId),
    );
    await env.DB.batch(stmts);
    const send = vi.spyOn(env.PROCESS_QUEUE, 'sendBatch').mockResolvedValue(undefined as never);
    expect(await requeueStalePending(env, new Date('2026-02-01T00:00:00.000Z'))).toBe(250);
    expect(send.mock.calls.map((c) => [...c[0]].length)).toEqual([100, 100, 50]);
    send.mockRestore();
  });
});
