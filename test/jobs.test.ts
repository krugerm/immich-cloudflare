import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expectResponse } from './contract';
import { authHeaders, BASE, createUser, login, uploadAsset } from './helpers';

const call = async (token: string | null, method: string, path: string, body?: unknown) => {
  const res = await SELF.fetch(`${BASE}/api${path}`, {
    method,
    headers: { ...(token ? authHeaders(token) : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const QUEUES = [
  'thumbnailGeneration', 'metadataExtraction', 'videoConversion', 'faceDetection', 'facialRecognition', 'smartSearch',
  'duplicateDetection', 'backgroundTask', 'storageTemplateMigration', 'migration', 'search', 'sidecar', 'library',
  'notifications', 'backupDatabase', 'ocr', 'workflow', 'integrityCheck', 'editor',
];

async function seed() {
  await createUser();
  await createUser({ email: 'user@example.com', isAdmin: false });
  const token = await login();
  const mk = async (n: number, status: string, backedUp = false) => {
    const id = (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(100 + n)))).body.id;
    await env.DB.prepare('UPDATE assets SET status = ?2, backed_up_at = ?3 WHERE id = ?1').bind(id, status, backedUp ? '2026-01-01T00:00:00.000Z' : null).run();
    return id;
  };
  return { token, mk };
}

afterEach(() => vi.restoreAllMocks());

describe('queues', () => {
  it('lists every queue with counts derived from asset rows', async () => {
    const { token, mk } = await seed();
    await mk(1, 'pending');
    await mk(2, 'pending');
    await mk(3, 'failed');
    await mk(4, 'ready', true);
    await mk(5, 'ready');
    const res = await call(token, 'GET', '/queues');
    expect(res.status).toBe(200);
    expectResponse('/queues', 'get', 200, res.body);
    expect(res.body.map((q: { name: string }) => q.name)).toEqual(QUEUES);
    const by = Object.fromEntries(res.body.map((q: any) => [q.name, q]));
    expect(by.thumbnailGeneration.statistics).toEqual({ active: 0, completed: 2, failed: 1, delayed: 0, waiting: 2, paused: 0 });
    expect(by.metadataExtraction.statistics).toEqual(by.thumbnailGeneration.statistics);
    expect(by.backupDatabase.statistics).toMatchObject({ waiting: 2, completed: 1 }); // the failed and the un-backed-up ready asset
    expect(by.smartSearch.statistics.waiting).toBe(2); // the two ready assets have no embedding
    const one = await call(token, 'GET', '/queues/thumbnailGeneration');
    expectResponse('/queues/{name}', 'get', 200, one.body);
    expect(one.body.statistics.waiting).toBe(2);
    expect(one.body.isPaused).toBe(false);
  });

  it('legacy /jobs has all queue names', async () => {
    const { token, mk } = await seed();
    await mk(1, 'failed');
    const res = await call(token, 'GET', '/jobs');
    expectResponse('/jobs', 'get', 200, res.body);
    expect(Object.keys(res.body).sort()).toEqual([...QUEUES].sort());
    expect(res.body.thumbnailGeneration.jobCounts.failed).toBe(1);
    expect(res.body.thumbnailGeneration.queueStatus).toEqual({ isPaused: false, isActive: false });
  });

  it('pauses and resumes; backgroundTask cannot be paused', async () => {
    const { token } = await seed();
    const paused = await call(token, 'PUT', '/queues/thumbnailGeneration', { isPaused: true });
    expect(paused.status).toBe(200);
    expectResponse('/queues/{name}', 'put', 200, paused.body);
    expect(paused.body.isPaused).toBe(true);
    expect((await call(token, 'GET', '/queues')).body.find((q: any) => q.name === 'thumbnailGeneration').isPaused).toBe(true);
    expect((await call(token, 'GET', '/jobs')).body.thumbnailGeneration.queueStatus.isPaused).toBe(true);
    expect((await call(token, 'PUT', '/queues/thumbnailGeneration', { isPaused: false })).body.isPaused).toBe(false);
    expect((await call(token, 'PUT', '/queues/backgroundTask', { isPaused: true })).status).toBe(400);
    expect((await call(token, 'PUT', '/queues/thumbnailGeneration', {})).status).toBe(200);
    // legacy commands
    const legacy = await call(token, 'PUT', '/jobs/ocr', { command: 'pause' });
    expectResponse('/jobs/{name}', 'put', 200, legacy.body);
    expect(legacy.body.queueStatus.isPaused).toBe(true);
    expect((await call(token, 'PUT', '/jobs/ocr', { command: 'resume' })).body.queueStatus.isPaused).toBe(false);
  });

  it('lists process-queue jobs by status', async () => {
    const { token, mk } = await seed();
    const p = await mk(1, 'pending');
    const f = await mk(2, 'failed');
    const r = await mk(3, 'ready');
    const ids = async (q: string) => {
      const res = await call(token, 'GET', `/queues/thumbnailGeneration/jobs${q}`);
      expect(res.status).toBe(200);
      expectResponse('/queues/{name}/jobs', 'get', 200, res.body);
      return res.body.map((j: { id: string }) => j.id).sort();
    };
    expect(await ids('')).toEqual([p, f].sort());
    expect(await ids('?status=waiting')).toEqual([p]);
    expect(await ids('?status=failed&status=completed')).toEqual([f, r].sort());
    expect(await ids('?status=active')).toEqual([]);
    const job = (await call(token, 'GET', '/queues/metadataExtraction/jobs?status=waiting')).body[0];
    expect(job).toMatchObject({ id: p, name: 'AssetExtractMetadata', data: { id: p } });
    expect(Number.isInteger(job.timestamp)).toBe(true);
    expect((await call(token, 'GET', '/queues/smartSearch/jobs')).body).toEqual([]);
    expect((await call(token, 'GET', '/queues/thumbnailGeneration/jobs?status=bogus')).status).toBe(400);
  });

  it('DELETE /queues/:name/jobs is an accepted no-op', async () => {
    const { token, mk } = await seed();
    await mk(1, 'failed');
    expect((await call(token, 'DELETE', '/queues/thumbnailGeneration/jobs', { failed: true })).status).toBe(204);
    expect((await call(token, 'DELETE', '/queues/thumbnailGeneration/jobs', { failed: 'x' })).status).toBe(400);
    expect((await call(token, 'DELETE', '/queues/nope/jobs', {})).status).toBe(400);
    expect((await call(token, 'GET', '/queues/thumbnailGeneration')).body.statistics.failed).toBe(1);
  });

  it('rejects bad names and bodies with 400', async () => {
    const { token } = await seed();
    expect((await call(token, 'GET', '/queues/nope')).status).toBe(400);
    expect((await call(token, 'GET', '/queues/nope/jobs')).status).toBe(400);
    expect((await call(token, 'PUT', '/queues/nope', { isPaused: true })).status).toBe(400);
    expect((await call(token, 'PUT', '/queues/ocr', { isPaused: 'x' })).status).toBe(400);
    expect((await call(token, 'PUT', '/jobs/nope', { command: 'start' })).status).toBe(400);
    expect((await call(token, 'PUT', '/jobs/ocr', { command: 'explode' })).status).toBe(400);
    expect((await call(token, 'PUT', '/jobs/ocr', {})).status).toBe(400);
    expect((await call(token, 'PUT', '/jobs/ocr', { command: 'start', force: 'yes' })).status).toBe(400);
    expect((await call(token, 'POST', '/jobs', { name: 'nope' })).status).toBe(400);
    expect((await call(token, 'POST', '/jobs', {})).status).toBe(400);
  });

  it('is admin only', async () => {
    await seed();
    const user = await login('user@example.com');
    for (const [m, p, b] of [['GET', '/queues'], ['GET', '/queues/ocr'], ['PUT', '/queues/ocr', { isPaused: true }], ['GET', '/queues/ocr/jobs'],
      ['DELETE', '/queues/ocr/jobs', {}], ['GET', '/jobs'], ['PUT', '/jobs/ocr', { command: 'start' }], ['POST', '/jobs', { name: 'memory-create' }]] as const) {
      expect((await call(user, m, p, b)).status, `${m} ${p}`).toBe(403);
      expect((await call(null, m, p, b)).status, `${m} ${p} anon`).toBe(401);
    }
  });
});

describe('queue commands', () => {
  it('start (missing) enqueues pending and failed assets in batches of 100', async () => {
    const { token, mk } = await seed();
    const p = await mk(1, 'pending');
    const f = await mk(2, 'failed');
    await mk(3, 'ready');
    const send = vi.spyOn(env.PROCESS_QUEUE, 'sendBatch').mockResolvedValue(undefined as never);
    const res = await call(token, 'PUT', '/jobs/thumbnailGeneration', { command: 'start' });
    expect(res.status).toBe(200);
    expectResponse('/jobs/{name}', 'put', 200, res.body);
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0][0] as Array<{ body: unknown }>).map((m) => m.body)).toEqual(expect.arrayContaining([{ assetId: p }, { assetId: f }]));
    expect((send.mock.calls[0][0] as unknown[]).length).toBe(2);
    send.mockClear();
    await call(token, 'PUT', '/jobs/metadataExtraction', { command: 'start', force: false });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('start with force enqueues every non-trashed asset with the force flag', async () => {
    const { token, mk } = await seed();
    const ids = [await mk(1, 'ready'), await mk(2, 'pending'), await mk(3, 'ready')];
    const trashed = await mk(4, 'ready');
    await env.DB.prepare("UPDATE assets SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1").bind(trashed).run();
    const send = vi.spyOn(env.PROCESS_QUEUE, 'sendBatch').mockResolvedValue(undefined as never);
    await call(token, 'PUT', '/jobs/metadataExtraction', { command: 'start', force: true });
    const bodies = (send.mock.calls.flatMap((c) => [...(c[0] as Iterable<unknown>)]) as Array<{ body: { assetId: string; force?: boolean } }>).map((m) => m.body);
    expect(bodies.map((b) => b.assetId).sort()).toEqual([...ids].sort());
    expect(bodies.every((b) => b.force === true)).toBe(true);
  });

  it('start batches at 100 messages per sendBatch', async () => {
    const { token } = await seed();
    const owner = (await env.DB.prepare('SELECT id FROM users LIMIT 1').first<string>('id'))!;
    const stmts = Array.from({ length: 230 }, (_, i) =>
      env.DB.prepare(
        `INSERT INTO assets (id, owner_id, device_asset_id, device_id, type, original_path, original_file_name, checksum, file_created_at, file_modified_at,
           local_date_time, file_size, status, created_at, updated_at, update_id)
         VALUES (?1, ?2, 'd', 'd', 'IMAGE', ?3, 'x.jpg', ?4, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z', 1, 'pending',
           '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z', '0')`,
      ).bind(crypto.randomUUID(), owner, `originals/x/${i}`, `sum${i}`),
    );
    await env.DB.batch(stmts);
    const send = vi.spyOn(env.PROCESS_QUEUE, 'sendBatch').mockResolvedValue(undefined as never);
    await call(token, 'PUT', '/jobs/thumbnailGeneration', { command: 'start' });
    expect(send.mock.calls.map((c) => (c[0] as unknown[]).length)).toEqual([100, 100, 30]);
  });

  it('start is a no-op while the queue is paused', async () => {
    const { token, mk } = await seed();
    await mk(1, 'pending');
    const send = vi.spyOn(env.PROCESS_QUEUE, 'sendBatch').mockResolvedValue(undefined as never);
    await call(token, 'PUT', '/queues/thumbnailGeneration', { isPaused: true });
    const res = await call(token, 'PUT', '/jobs/thumbnailGeneration', { command: 'start' });
    expect(res.status).toBe(200);
    expect(res.body.queueStatus.isPaused).toBe(true);
    expect(send).not.toHaveBeenCalled();
    await call(token, 'PUT', '/jobs/thumbnailGeneration', { command: 'resume' });
    await call(token, 'PUT', '/jobs/thumbnailGeneration', { command: 'start' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('start continues after a stored cursor and clears it on a short batch', async () => {
    const { token, mk } = await seed();
    const ids = [await mk(1, 'pending'), await mk(2, 'pending'), await mk(3, 'pending')].sort();
    await env.DB.prepare("INSERT INTO server_state (key, value, updated_at) VALUES ('start_cursor:thumbnailGeneration:missing', ?1, 'x')").bind(JSON.stringify(ids[0])).run();
    const send = vi.spyOn(env.PROCESS_QUEUE, 'sendBatch').mockResolvedValue(undefined as never);
    await call(token, 'PUT', '/jobs/thumbnailGeneration', { command: 'start' });
    const sent = (send.mock.calls[0][0] as Array<{ body: { assetId: string } }>).map((m) => m.body.assetId);
    expect(sent).toEqual([ids[1], ids[2]]);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM server_state WHERE key LIKE 'start_cursor%'").first<number>('n')).toBe(0);
  });

  it('backupDatabase start and POST /jobs backup-database requeue missing backups', async () => {
    const { token, mk } = await seed();
    const unbacked = await mk(1, 'ready');
    await mk(2, 'ready', true);
    await mk(3, 'pending');
    const send = vi.spyOn(env.BACKUP_QUEUE, 'sendBatch').mockResolvedValue(undefined as never);
    expect((await call(token, 'PUT', '/jobs/backupDatabase', { command: 'start' })).status).toBe(200);
    expect(send.mock.calls[0][0]).toEqual([{ body: { assetId: unbacked } }]);
    send.mockClear();
    expect((await call(token, 'POST', '/jobs', { name: 'backup-database' })).status).toBe(204);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('commands for features this server lacks return queue state and enqueue nothing', async () => {
    const { token, mk } = await seed();
    await mk(1, 'pending');
    const proc = vi.spyOn(env.PROCESS_QUEUE, 'sendBatch').mockResolvedValue(undefined as never);
    const backup = vi.spyOn(env.BACKUP_QUEUE, 'sendBatch').mockResolvedValue(undefined as never);
    for (const name of ['videoConversion', 'faceDetection', 'facialRecognition', 'smartSearch', 'duplicateDetection', 'sidecar', 'library', 'ocr', 'storageTemplateMigration', 'migration']) {
      for (const command of ['start', 'empty', 'clear-failed']) {
        const res = await call(token, 'PUT', `/jobs/${name}`, { command, force: true });
        expect(res.status, `${name} ${command}`).toBe(200);
        expectResponse('/jobs/{name}', 'put', 200, res.body);
      }
    }
    for (const name of ['backgroundTask', 'search', 'notifications', 'workflow', 'integrityCheck', 'editor']) {
      expect((await call(token, 'PUT', `/jobs/${name}`, { command: 'start' })).status, name).toBe(400);
    }
    for (const name of ['person-cleanup', 'tag-cleanup', 'user-cleanup', 'integrity-missing-files', 'integrity-checksum-mismatch-delete-all']) {
      expect((await call(token, 'POST', '/jobs', { name })).status, name).toBe(204);
    }
    expect(proc).not.toHaveBeenCalled();
    expect(backup).not.toHaveBeenCalled();
  });

  it('POST /jobs memory-cleanup runs', async () => {
    const { token } = await seed();
    expect((await call(token, 'POST', '/jobs', { name: 'memory-cleanup' })).status).toBe(204);
  });
});

describe('forced reprocessing', () => {
  it('a force message reprocesses a ready asset, a plain one does not', async () => {
    const { mk } = await seed();
    const id = await mk(1, 'ready');
    const { processAsset } = await import('../src/process/consumer');
    const calls: number[] = [];
    const thumbnailer = {
      info: async () => {
        calls.push(1);
        throw new Error('stop 9400');
      },
      render: async () => new Uint8Array(),
    };
    await env.MEDIA.put((await env.DB.prepare('SELECT original_path FROM assets WHERE id = ?1').bind(id).first<string>('original_path'))!, new Uint8Array([1, 2, 3]));
    await processAsset(env, id, thumbnailer as never);
    expect(calls).toHaveLength(0);
    await processAsset(env, id, thumbnailer as never, true);
    expect(calls).toHaveLength(1);
  });
});
