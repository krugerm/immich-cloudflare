import { env, SELF } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { runScheduled } from '../src/cron/index';
import { authHeaders, BASE, createUser, login, uploadAsset } from './helpers';

const DAILY = '17 3 * * *';
const withMedia = { ...env, MEDIA_CONTAINER: {} } as unknown as Env;
// The test runtime binds the MediaContainer Durable Object namespace, so "unbound" is simulated explicitly.
const withoutMedia = { ...env, MEDIA_CONTAINER: undefined } as unknown as Env;

async function setup(status: string) {
  await createUser();
  const token = await login();
  const id = (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(100)))).body.id as string;
  await env.DB.prepare('UPDATE assets SET status = ?2 WHERE id = ?1').bind(id, status).run();
  return { token, id };
}

const put = (token: string, path: string, body: unknown) =>
  SELF.fetch(`${BASE}/api${path}`, { method: 'PUT', headers: { ...authHeaders(token), 'content-type': 'application/json' }, body: JSON.stringify(body) });

function spy() {
  return vi.spyOn(env.PROCESS_QUEUE, 'sendBatch').mockResolvedValue(undefined as never);
}
const sentIds = (s: ReturnType<typeof spy>) => s.mock.calls.flatMap((c) => (c[0] as unknown as { body: { assetId: string } }[])).map((m) => m.body.assetId);

describe('needs_media requeue and stats', () => {
  it('non-force start enqueues needs_media assets', async () => {
    const { token, id } = await setup('needs_media');
    const send = spy();
    expect((await put(token, '/jobs/thumbnailGeneration', { command: 'start' })).status).toBe(200);
    expect(sentIds(send)).toEqual([id]);
    send.mockRestore();
  });

  it('counts needs_media as waiting', async () => {
    const { token } = await setup('needs_media');
    const res = await SELF.fetch(`${BASE}/api/jobs`, { headers: authHeaders(token) });
    const body = (await res.json()) as Record<string, { jobCounts: { waiting: number } }>;
    expect(body.thumbnailGeneration.jobCounts.waiting).toBe(1);
  });

  it('daily cron requeues needs_media only when MEDIA_CONTAINER is bound', async () => {
    const { id } = await setup('needs_media');
    const send = spy();
    await runScheduled(DAILY, withoutMedia);
    expect(sentIds(send)).not.toContain(id);
    // Bound but without the grant secret: still unusable, so nothing is sent (and nothing can fail).
    await runScheduled(DAILY, { ...withMedia, MEDIA_GRANT_SECRET: undefined } as Env);
    expect(sentIds(send)).not.toContain(id);
    await runScheduled(DAILY, withMedia);
    expect(sentIds(send)).toEqual([id]);
    send.mockRestore();
  });

  it('daily cron requeues at most 200 needs_media assets, oldest first', async () => {
    const { id } = await setup('needs_media');
    await env.DB.prepare("UPDATE assets SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?1").bind(id).run();
    const owner = await env.DB.prepare('SELECT owner_id FROM assets WHERE id = ?1').bind(id).first<string>('owner_id');
    const stmts = [];
    for (let i = 0; i < 205; i++) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO assets (id, owner_id, device_asset_id, device_id, type, original_path, original_file_name, checksum, file_created_at, file_modified_at, local_date_time, file_size, status, created_at, updated_at, update_id)
           VALUES (?1, ?2, 'd', 'd', 'IMAGE', 'p', 'f', ?1, 'x', 'x', 'x', 1, 'needs_media', '2024-01-01T00:00:00.000Z', 'x', ?1)`,
        ).bind(`bulk-${i}`, owner),
      );
    }
    await env.DB.batch(stmts);
    const send = spy();
    await runScheduled(DAILY, withMedia);
    const ids = sentIds(send);
    expect(ids).toHaveLength(200);
    expect(ids[0]).toBe(id);
    send.mockRestore();
  });
});
