import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { cleanupMemories, generateMemories } from '../src/memories/generate';
import { expectResponse, expectSchema } from './contract';
import { authHeaders, BASE, createUser, login, uploadAsset } from './helpers';

async function call(token: string, method: string, path: string, body?: unknown) {
  const res = await SELF.fetch(`${BASE}/api${path}`, {
    method,
    headers: { ...authHeaders(token), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function setup() {
  await createUser();
  await createUser({ email: 'other@example.com', isAdmin: false });
  const token = await login();
  const other = await login('other@example.com');
  const up = async (t: string, n: number) => (await uploadAsset(t, crypto.getRandomValues(new Uint8Array(100 + n)))).body.id;
  return { token, other, up };
}

const memoryBody = (over: Record<string, unknown> = {}) => ({
  type: 'on_this_day', data: { year: 2020 }, memoryAt: '2020-05-04T00:00:00.000Z', ...over,
});

describe('memories CRUD', () => {
  it('creates, reads, updates and deletes a memory', async () => {
    const { token, up } = await setup();
    const a = await up(token, 1);
    const created = await call(token, 'POST', '/memories', memoryBody({ assetIds: [a], showAt: '2026-10-12T00:00:00.000Z', hideAt: '2026-10-12T23:59:59.999Z' }));
    expect(created.status).toBe(201);
    expectResponse('/memories', 'post', 201, created.body);
    expect(created.body.assets.map((x: { id: string }) => x.id)).toEqual([a]);
    expect(created.body.isSaved).toBe(false);
    const id = created.body.id;

    const got = await call(token, 'GET', `/memories/${id}`);
    expect(got.status).toBe(200);
    expectResponse('/memories/{id}', 'get', 200, got.body);

    const upd = await call(token, 'PUT', `/memories/${id}`, { isSaved: true, seenAt: '2026-10-12T10:00:00Z' });
    expect(upd.status).toBe(200);
    expectResponse('/memories/{id}', 'put', 200, upd.body);
    expect(upd.body.isSaved).toBe(true);
    expect(upd.body.seenAt).toBe('2026-10-12T10:00:00.000Z');
    expect(upd.body.updatedAt >= created.body.updatedAt).toBe(true);

    expect((await call(token, 'DELETE', `/memories/${id}`)).status).toBe(204);
    expect((await call(token, 'GET', `/memories/${id}`)).status).toBe(400);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM memory_assets').first<number>('n')).toBe(0);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM memory_audit').first<number>('n')).toBe(1);
  });

  it('silently drops assets the user does not own on create', async () => {
    const { token, other, up } = await setup();
    const mine = await up(token, 1);
    const theirs = await up(other, 2);
    const res = await call(token, 'POST', '/memories', memoryBody({ assetIds: [mine, theirs] }));
    expect(res.body.assets.map((x: { id: string }) => x.id)).toEqual([mine]);
  });

  it("another user's memory is not accessible (400 as in Immich)", async () => {
    const { token, other } = await setup();
    const id = (await call(token, 'POST', '/memories', memoryBody())).body.id;
    for (const [m, p, b] of [['GET', `/memories/${id}`], ['PUT', `/memories/${id}`, { isSaved: true }], ['DELETE', `/memories/${id}`],
      ['PUT', `/memories/${id}/assets`, { ids: [] }], ['DELETE', `/memories/${id}/assets`, { ids: [] }]] as const) {
      const res = await call(other, m, p, b);
      expect(res.status, `${m} ${p}`).toBe(400);
      expect(res.body.message).toMatch(/Not found or no memory\./);
    }
    expect((await call(token, 'GET', `/memories/${id}`)).status).toBe(200);
  });

  it('rejects bad input with 400', async () => {
    const { token } = await setup();
    const id = (await call(token, 'POST', '/memories', memoryBody())).body.id;
    const bads: Array<[string, string, unknown]> = [
      ['POST', '/memories', {}],
      ['POST', '/memories', memoryBody({ type: 'nope' })],
      ['POST', '/memories', memoryBody({ data: { year: 20 } })],
      ['POST', '/memories', memoryBody({ data: 'x' })],
      ['POST', '/memories', memoryBody({ memoryAt: 'yesterday' })],
      ['POST', '/memories', memoryBody({ assetIds: ['nope'] })],
      ['POST', '/memories', memoryBody({ type: 'birthday' })],
      ['POST', '/memories', memoryBody({ isSaved: 'yes' })],
      ['POST', '/memories', [1]],
      ['PUT', `/memories/${id}`, {}],
      ['PUT', `/memories/${id}`, { isSaved: 'x' }],
      ['PUT', `/memories/${id}`, { seenAt: null }],
      ['PUT', `/memories/${id}/assets`, { ids: ['x'] }],
      ['PUT', `/memories/${id}/assets`, {}],
      ['GET', '/memories/not-a-uuid', undefined],
      ['DELETE', '/memories/not-a-uuid', undefined],
    ];
    for (const [m, p, b] of bads) {
      const res = await call(token, m, p, b);
      expect(res.status, `${m} ${p} ${JSON.stringify(b)}`).toBe(400);
    }
    for (const q of ['isSaved=maybe', 'size=0', 'page=x', 'type=x', 'order=x', 'for=nope', 'id=x']) {
      expect((await call(token, 'GET', `/memories?${q}`)).status, q).toBe(400);
      expect((await call(token, 'GET', `/memories/statistics?${q}`)).status, q).toBe(400);
    }
  });

  it('birthday memories need personId and personName', async () => {
    const { token } = await setup();
    const personId = crypto.randomUUID();
    const ok = await call(token, 'POST', '/memories', memoryBody({ type: 'birthday', data: { year: 1990, personId, personName: 'Ann' } }));
    expect(ok.status).toBe(201);
    expect(ok.body.data).toEqual({ year: 1990, personId, personName: 'Ann' });
  });

  it('requires auth', async () => {
    expect((await SELF.fetch(`${BASE}/api/memories`)).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/api/memories/statistics`)).status).toBe(401);
  });
});

describe('memory assets', () => {
  it('adds with duplicate / no_permission results and removes with not_found', async () => {
    const { token, other, up } = await setup();
    const a = await up(token, 1);
    const b = await up(token, 2);
    const foreign = await up(other, 3);
    const id = (await call(token, 'POST', '/memories', memoryBody({ assetIds: [a] }))).body.id;

    const add = await call(token, 'PUT', `/memories/${id}/assets`, { ids: [a, b, foreign, b] });
    expect(add.status).toBe(200);
    expectResponse('/memories/{id}/assets', 'put', 200, add.body);
    expect(add.body).toEqual([
      { id: a, success: false, error: 'duplicate' },
      { id: b, success: true },
      { id: foreign, success: false, error: 'no_permission' },
      { id: b, success: false, error: 'duplicate' },
    ]);
    expect((await call(token, 'GET', `/memories/${id}`)).body.assets).toHaveLength(2);

    const rm = await call(token, 'DELETE', `/memories/${id}/assets`, { ids: [a, foreign, a] });
    expectResponse('/memories/{id}/assets', 'delete', 200, rm.body);
    expect(rm.body).toEqual([
      { id: a, success: true },
      { id: foreign, success: false, error: 'not_found' },
      { id: a, success: false, error: 'not_found' },
    ]);
    expect((await call(token, 'GET', `/memories/${id}`)).body.assets.map((x: { id: string }) => x.id)).toEqual([b]);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM memory_asset_audit').first<number>('n')).toBe(1);
  });

  it('hides trashed and non-timeline assets from responses', async () => {
    const { token, up } = await setup();
    const a = await up(token, 1);
    const b = await up(token, 2);
    const c = await up(token, 3);
    const id = (await call(token, 'POST', '/memories', memoryBody({ assetIds: [a, b, c] }))).body.id;
    await env.DB.prepare("UPDATE assets SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1").bind(a).run();
    await env.DB.prepare("UPDATE assets SET visibility = 'archive' WHERE id = ?1").bind(b).run();
    expect((await call(token, 'GET', `/memories/${id}`)).body.assets.map((x: { id: string }) => x.id)).toEqual([c]);
  });
});

describe('memory search and statistics', () => {
  it('filters, orders and pages; statistics match the filter', async () => {
    const { token, other, up } = await setup();
    const a = await up(token, 1);
    const mk = (over: Record<string, unknown>) => call(token, 'POST', '/memories', memoryBody({ assetIds: [a], ...over }));
    const m1 = (await mk({ memoryAt: '2019-05-04T00:00:00.000Z', showAt: '2026-10-10T00:00:00.000Z', hideAt: '2026-10-10T23:59:59.999Z' })).body;
    const m2 = (await mk({ memoryAt: '2020-05-04T00:00:00.000Z', showAt: '2026-10-12T00:00:00.000Z', hideAt: '2026-10-12T23:59:59.999Z', isSaved: true })).body;
    const m3 = (await mk({ memoryAt: '2021-05-04T00:00:00.000Z' })).body;
    await call(token, 'POST', '/memories', memoryBody()); // no assets: hidden from search, counted in statistics
    await call(other, 'POST', '/memories', memoryBody());

    const ids = async (q: string) => {
      const r = await call(token, 'GET', `/memories${q}`);
      expect(r.status).toBe(200);
      expectResponse('/memories', 'get', 200, r.body);
      return r.body.map((m: { id: string }) => m.id);
    };
    expect(await ids('')).toEqual([m2.id, m1.id, m3.id]); // show_at desc, nulls last
    expect(await ids('?order=asc')).toEqual([m1.id, m2.id, m3.id]);
    expect(await ids('?isSaved=true')).toEqual([m2.id]);
    expect(await ids('?for=2026-10-12')).toEqual([m2.id, m3.id]);
    expect(await ids('?size=1&page=2')).toEqual([m1.id]);
    expect(await ids(`?id=${m3.id}`)).toEqual([m3.id]);
    expect(await ids('?isTrashed=true')).toEqual([]);
    expect(await ids('?type=birthday')).toEqual([]);
    expect(await ids('?order=random')).toHaveLength(3);
    expect(await ids('?isUpcoming=true')).toEqual([]);

    const stats = await call(token, 'GET', '/memories/statistics');
    expectResponse('/memories/statistics', 'get', 200, stats.body);
    expect(stats.body).toEqual({ total: 4 });
    expect((await call(token, 'GET', '/memories/statistics?isSaved=true')).body).toEqual({ total: 1 });
  });
});

describe('memory sync', () => {
  async function sync(token: string, types: string[]) {
    const res = await SELF.fetch(`${BASE}/api/sync/stream`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ types }),
    });
    return (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string; data: Record<string, unknown>; ack: string });
  }
  const ackAll = async (token: string, lines: Array<{ ack: string; type: string }>) => {
    const last = new Map<string, string>();
    for (const l of lines) if (l.type !== 'SyncCompleteV1') last.set(l.type, l.ack);
    await call(token, 'POST', '/sync/ack', { acks: [...last.values()] });
  };

  it('streams memories, memory assets and their deletes in order', async () => {
    const { token, other, up } = await setup();
    const a = await up(token, 1);
    const b = await up(token, 2);
    const id = (await call(token, 'POST', '/memories', memoryBody({ assetIds: [a, b] }))).body.id;
    await call(other, 'POST', '/memories', memoryBody()); // not visible to the first user
    const types = ['MemoryToAssetsV2', 'MemoriesV2', 'AssetsV2'];

    let lines = await sync(token, types);
    expect(lines.map((l) => l.type)).toEqual(['AssetV2', 'AssetV2', 'MemoryV2', 'MemoryToAssetV2', 'MemoryToAssetV2', 'SyncCompleteV1']);
    expectSchema('SyncMemoryV2', lines[2].data);
    expect(lines[2].data).toMatchObject({ id, type: 'on_this_day', data: { year: 2020 }, deletedAt: null, seenAt: null, isSaved: false });
    expectSchema('SyncMemoryAssetV1', lines[3].data);
    expect(lines[3].data.memoryId).toBe(id);
    expect(lines[2].ack).toMatch(/^MemoryV2\|00000000-0000-7000-8000-[0-9a-f]{12}$/);
    await ackAll(token, lines);
    expect((await sync(token, types)).map((l) => l.type)).toEqual(['SyncCompleteV1']);

    await call(token, 'PUT', `/memories/${id}`, { isSaved: true });
    lines = await sync(token, types);
    expect(lines.map((l) => l.type)).toEqual(['MemoryV2', 'SyncCompleteV1']);
    expect(lines[0].data.isSaved).toBe(true);
    await ackAll(token, lines);

    await call(token, 'DELETE', `/memories/${id}/assets`, { ids: [a] });
    lines = await sync(token, types);
    expect(lines.map((l) => l.type)).toEqual(['MemoryV2', 'MemoryToAssetDeleteV1', 'SyncCompleteV1']);
    expectSchema('SyncMemoryAssetDeleteV1', lines[1].data);
    expect(lines[1].data).toEqual({ memoryId: id, assetId: a });
    await ackAll(token, lines);

    await call(token, 'PUT', `/memories/${id}/assets`, { ids: [a] });
    lines = await sync(token, types);
    expect(lines.map((l) => l.type)).toEqual(['MemoryV2', 'MemoryToAssetV2', 'SyncCompleteV1']);
    await ackAll(token, lines);

    await call(token, 'DELETE', `/memories/${id}`);
    lines = await sync(token, types);
    expect(lines.map((l) => l.type)).toEqual(['MemoryDeleteV1', 'SyncCompleteV1']);
    expectSchema('SyncMemoryDeleteV1', lines[0].data);
    expect(lines[0].data).toEqual({ memoryId: id });
  });
});

describe('on this day generation', () => {
  async function seedAsset(token: string, n: number, localDate: string) {
    const id = (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(200 + n)))).body.id;
    await env.DB.prepare('UPDATE assets SET local_date_time = ?2, has_thumbnail = 1, status = ?3 WHERE id = ?1').bind(id, localDate, 'ready').run();
    return id;
  }

  it('creates one memory per earlier year with up to 20 assets, once per day', async () => {
    const { token, other } = await setup();
    const now = new Date('2026-10-12T05:00:00.000Z');
    const y1 = await seedAsset(token, 1, '2024-10-12T09:00:00.000Z');
    const y2 = await seedAsset(token, 2, '2023-10-12T09:00:00.000Z');
    await seedAsset(token, 3, '2026-10-12T09:00:00.000Z'); // this year: no memory
    await seedAsset(token, 4, '2024-10-13T09:00:00.000Z'); // another day, shows up in its own run
    const trashed = await seedAsset(token, 5, '2022-10-12T09:00:00.000Z');
    await env.DB.prepare("UPDATE assets SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1").bind(trashed).run();
    await seedAsset(other, 6, '2021-10-12T09:00:00.000Z');

    const created = await generateMemories(env, now);
    expect(created).toBe(4); // user: 2024, 2023, and 2024 (10-13); other: 2021
    const rows = await env.DB.prepare("SELECT * FROM memories WHERE owner_id = (SELECT id FROM users WHERE email = 'admin@example.com') ORDER BY memory_at").all<Record<string, string>>();
    const today = rows.results.filter((m) => m.memory_at.slice(5, 10) === '10-12');
    expect(today.map((m) => m.memory_at)).toEqual(['2023-10-12T00:00:00.000Z', '2024-10-12T00:00:00.000Z']);
    expect(today[0]).toMatchObject({ type: 'on_this_day', show_at: '2026-10-12T00:00:00.000Z', hide_at: '2026-10-12T23:59:59.999Z' });
    expect(JSON.parse(today[1].data)).toEqual({ year: 2024 });

    const res = await call(token, 'GET', '/memories?for=2026-10-12');
    expectResponse('/memories', 'get', 200, res.body);
    expect(res.body.flatMap((m: { assets: { id: string }[] }) => m.assets.map((a) => a.id)).sort()).toEqual([y1, y2].sort());

    expect(await generateMemories(env, now)).toBe(0); // state prevents duplicates
    expect(await generateMemories(env, new Date('2026-10-13T05:00:00.000Z'))).toBe(0); // 10-13 was already generated by the 10-12 run (window +3 days)
  });

  it('caps a year at 20 assets', async () => {
    const { token } = await setup();
    for (let i = 0; i < 22; i++) await seedAsset(token, i, `2024-10-12T09:${String(i).padStart(2, '0')}:00.000Z`);
    await generateMemories(env, new Date('2026-10-12T05:00:00.000Z'));
    expect(await env.DB.prepare('SELECT count(*) AS n FROM memory_assets').first<number>('n')).toBe(20);
  });

  it('runs from POST /jobs memory-create', async () => {
    const { token } = await setup();
    await seedAsset(token, 1, `${new Date().getUTCFullYear() - 1}-${new Date().toISOString().slice(5, 10)}T09:00:00.000Z`);
    expect((await call(token, 'POST', '/jobs', { name: 'memory-create' })).status).toBe(204);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM memories').first<number>('n')).toBeGreaterThan(0);
  });
});

describe('generation idempotency and bounds', () => {
  async function seedAsset(token: string, n: number, localDate: string) {
    const id = (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(300 + n)))).body.id;
    await env.DB.prepare("UPDATE assets SET local_date_time = ?2, has_thumbnail = 1, status = 'ready' WHERE id = ?1").bind(id, localDate, ).run();
    return id;
  }
  const count = async () => (await env.DB.prepare('SELECT count(*) AS n FROM memories').first<number>('n'))!;
  const now = new Date('2026-10-12T05:00:00.000Z');

  it('rerunning generation for the same days (state lost) creates no duplicates', async () => {
    const { token } = await setup();
    await seedAsset(token, 1, '2024-10-12T09:00:00.000Z');
    await seedAsset(token, 2, '2023-10-12T09:00:00.000Z');
    expect(await generateMemories(env, now)).toBe(2);
    await env.DB.prepare("DELETE FROM server_state WHERE key = 'memories_state'").run();
    expect(await generateMemories(env, now)).toBe(0);
    expect(await count()).toBe(2);
  });

  it('a duplicate on-this-day key is ignored by createMemory and rejected by POST', async () => {
    const { token } = await setup();
    const body = memoryBody({ showAt: '2026-10-12T00:00:00.000Z' });
    expect((await call(token, 'POST', '/memories', body)).status).toBe(201);
    expect((await call(token, 'POST', '/memories', body)).status).toBe(400);
    expect(await count()).toBe(1);
  });

  it('creates at most cap memories per run and continues on the next', async () => {
    const { token } = await setup();
    for (let y = 2015; y < 2022; y++) await seedAsset(token, y, `${y}-10-12T09:00:00.000Z`);
    expect(await generateMemories(env, now, { cap: 3 })).toBe(3);
    expect(await generateMemories(env, now, { cap: 3 })).toBe(3);
    expect(await generateMemories(env, now, { cap: 3 })).toBe(1);
    expect(await count()).toBe(7);
    expect(await generateMemories(env, now, { cap: 3 })).toBe(0);
    expect(await count()).toBe(7);
    const state = await env.DB.prepare("SELECT value FROM server_state WHERE key = 'memories_state'").first<string>('value');
    expect(JSON.parse(state!).lastOnThisDayDate).toBe('2026-10-15T00:00:00.000Z');
  });

  it('purging an asset audits its memory links for sync', async () => {
    const { token, up } = await setup();
    const a = await up(token, 1);
    const id = (await call(token, 'POST', '/memories', memoryBody({ assetIds: [a] }))).body.id;
    await env.DB.prepare("UPDATE assets SET deleted_at = '2020-01-01T00:00:00.000Z' WHERE id = ?1").bind(a).run();
    const { purgeTrash } = await import('../src/cron/purge');
    await purgeTrash(env);
    const audit = await env.DB.prepare('SELECT memory_id, asset_id FROM memory_asset_audit').all<Record<string, string>>();
    expect(audit.results).toEqual([{ memory_id: id, asset_id: a }]);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM memory_assets').first<number>('n')).toBe(0);
  });
});

describe('memory cleanup', () => {
  it('drops non-timeline assets and old unsaved memories', async () => {
    const { token, up } = await setup();
    const a = await up(token, 1);
    const b = await up(token, 2);
    const old = (await call(token, 'POST', '/memories', memoryBody({ assetIds: [a] }))).body.id;
    const saved = (await call(token, 'POST', '/memories', memoryBody({ assetIds: [a], isSaved: true }))).body.id;
    const fresh = (await call(token, 'POST', '/memories', memoryBody({ assetIds: [a, b] }))).body.id;
    await env.DB.prepare("UPDATE memories SET created_at = '2020-01-01T00:00:00.000Z' WHERE id IN (?1, ?2)").bind(old, saved).run();
    await env.DB.prepare("UPDATE assets SET visibility = 'archive' WHERE id = ?1").bind(a).run();

    await cleanupMemories(env);
    const ids = (await env.DB.prepare('SELECT id FROM memories').all<{ id: string }>()).results.map((r) => r.id);
    expect(ids.sort()).toEqual([saved, fresh].sort());
    const links = (await env.DB.prepare('SELECT memory_id, asset_id FROM memory_assets').all<{ memory_id: string; asset_id: string }>()).results;
    expect(links.map((l) => `${l.memory_id}:${l.asset_id}`)).toEqual([`${fresh}:${b}`]);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM memory_audit').first<number>('n')).toBe(1);
  });
});
