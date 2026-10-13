import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { HANDLED_CRONS, runScheduled } from '../src/cron/index';
import wranglerRaw from '../wrangler.jsonc?raw';
import { createUser, login, uploadAsset } from './helpers';

const up = async () => {
  await createUser();
  const token = await login();
  return (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(100)))).body.id;
};

describe('cron routing', () => {
  it('handles every cron string in wrangler.jsonc triggers', () => {
    // wrangler.jsonc carries whole-line // comments; drop them before parsing as JSON.
    const crons: string[] = JSON.parse(wranglerRaw.replace(/^\s*\/\/.*$/gm, '')).triggers.crons;
    expect(crons.length).toBeGreaterThan(0);
    for (const c of crons) expect(HANDLED_CRONS).toContain(c);
    expect([...HANDLED_CRONS].sort()).toEqual([...crons].sort());
  });

  it('weekly cron requeues assets missing a backup', async () => {
    const id = await up();
    await env.DB.prepare("UPDATE assets SET status = 'ready' WHERE id = ?1").bind(id).run();
    const send = vi.spyOn(env.BACKUP_QUEUE, 'sendBatch').mockResolvedValue(undefined as never);
    await runScheduled('41 4 * * SUN', env);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toEqual([{ body: { assetId: id } }]);
    send.mockRestore();
  });

  it('daily cron purges old trash and requeues stale pending assets', async () => {
    const stale = await up();
    const token = await login();
    const trashed = (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(101)))).body.id;
    await env.DB.prepare("UPDATE assets SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1").bind(stale).run();
    await env.DB.prepare("UPDATE assets SET status = 'ready', deleted_at = '2020-01-01T00:00:00.000Z' WHERE id = ?1").bind(trashed).run();
    const send = vi.spyOn(env.PROCESS_QUEUE, 'sendBatch').mockResolvedValue(undefined as never);
    await runScheduled('17 3 * * *', env);
    expect(send.mock.calls[0][0]).toEqual([{ body: { assetId: stale } }]);
    expect(await env.DB.prepare('SELECT id FROM assets WHERE id = ?1').bind(trashed).first()).toBeNull();
    send.mockRestore();
  });

  it('a failing daily step does not skip the later ones', async () => {
    const stale = await up();
    const token = await login();
    const trashed = (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(102)))).body.id;
    await env.DB.prepare("UPDATE assets SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1").bind(stale).run();
    await env.DB.prepare("UPDATE assets SET status = 'ready', deleted_at = '2020-01-01T00:00:00.000Z' WHERE id = ?1").bind(trashed).run();
    await env.DB.prepare("INSERT INTO login_failures (email, failures, window_start) VALUES ('login:x@y.z', 3, '2020-01-01T00:00:00.000Z')").run();
    // purgeTrash, the first step, throws on its R2 delete (after its D1 commit, so the keys stay queued for the next run)
    const broken = { ...env, MEDIA: { delete: async () => { throw new Error('r2 down'); } } } as unknown as Env;
    const send = vi.spyOn(env.PROCESS_QUEUE, 'sendBatch').mockResolvedValue(undefined as never);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runScheduled('17 3 * * *', broken);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM r2_delete_queue WHERE asset_id = ?1').bind(trashed).first('n')).toBe(5);
    expect(send.mock.calls[0][0]).toEqual([{ body: { assetId: stale } }]);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM login_failures').first('n')).toBe(0);
    expect(logged.mock.calls.some((c) => String(c[0]).includes('purgeTrash'))).toBe(true);
    send.mockRestore();
    logged.mockRestore();
  });

  it('ignores unknown cron strings', async () => {
    const send = vi.spyOn(env.BACKUP_QUEUE, 'sendBatch');
    await runScheduled('0 0 * * *', env);
    expect(send).not.toHaveBeenCalled();
    send.mockRestore();
  });
});
