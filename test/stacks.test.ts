import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { purgeAssets } from '../src/cron/purge';
import type { AssetRow } from '../src/db/rows';
import { expectResponse, expectSchema } from './contract';
import { authHeaders, BASE, createUser, login, uploadAsset } from './helpers';
import { call } from './tags.test';

type Line = { type: string; data: Record<string, any>; ack: string };

async function sync(token: string, types: string[]): Promise<Line[]> {
  const res = await SELF.fetch(`${BASE}/api/sync/stream`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify({ types }),
  });
  return (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function ackAll(token: string, lines: Line[]) {
  const last = new Map<string, string>();
  for (const l of lines) if (l.type !== 'SyncCompleteV1') last.set(l.type, l.ack);
  await call(token, 'POST', '/sync/ack', { acks: [...last.values()] });
}

async function setup(count = 4) {
  await createUser();
  await createUser({ email: 'other@example.com', name: 'Other', isAdmin: false });
  const token = await login();
  const other = await login('other@example.com');
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = `2024-05-0${i + 1}T10:00:00.000Z`;
    ids.push((await uploadAsset(token, crypto.getRandomValues(new Uint8Array(100 + i)), { fields: { fileCreatedAt: d, fileModifiedAt: d } })).body.id);
  }
  const foreign = (await uploadAsset(other, crypto.getRandomValues(new Uint8Array(300)))).body.id;
  return { token, other, ids, foreign };
}

const stackIdOf = async (id: string) => (await env.DB.prepare('SELECT stack_id FROM assets WHERE id = ?1').bind(id).first<{ stack_id: string | null }>())!.stack_id;

describe('stacks', () => {
  it('creates a stack with the first asset as primary', async () => {
    const { token, ids } = await setup();
    const res = await call(token, 'POST', '/stacks', { assetIds: [ids[1], ids[0], ids[2]] });
    expect(res.status).toBe(201);
    expectResponse('/stacks', 'post', 201, res.body);
    expect(res.body.primaryAssetId).toBe(ids[1]);
    expect(res.body.assets.map((a: any) => a.id)).toEqual([ids[1], ids[0], ids[2]]); // primary first, then oldest first
    expect(await stackIdOf(ids[0])).toBe(res.body.id);
    expect(await stackIdOf(ids[3])).toBeNull();
  });

  it('rejects fewer than two ids, bad ids and foreign assets with 400', async () => {
    const { token, ids, foreign } = await setup();
    expect((await call(token, 'POST', '/stacks', { assetIds: [ids[0]] })).status).toBe(400);
    expect((await call(token, 'POST', '/stacks', { assetIds: [ids[0], 'x'] })).status).toBe(400);
    expect((await call(token, 'POST', '/stacks', { assetIds: [ids[0], foreign] })).status).toBe(400);
    expect((await call(token, 'POST', '/stacks', { assetIds: [ids[0], crypto.randomUUID()] })).status).toBe(400);
    expect((await call(token, 'POST', '/stacks', {})).status).toBe(400);
    expect((await SELF.fetch(`${BASE}/api/stacks`, { method: 'POST' })).status).toBe(401);
  });

  it('merges an existing stack whose primary is in the new id list', async () => {
    const { token, ids } = await setup();
    const first = (await call(token, 'POST', '/stacks', { assetIds: [ids[0], ids[1]] })).body;
    const second = (await call(token, 'POST', '/stacks', { assetIds: [ids[2], ids[0]] })).body;
    expect(second.assets.map((a: any) => a.id).sort()).toEqual([ids[0], ids[1], ids[2]].sort());
    expect((await call(token, 'GET', `/stacks/${first.id}`)).status).toBe(400);
    expect(await stackIdOf(ids[1])).toBe(second.id);
    expect((await call(token, 'GET', '/stacks')).body).toHaveLength(1);
  });

  it('gets, searches and filters by primary asset', async () => {
    const { token, ids } = await setup();
    const s1 = (await call(token, 'POST', '/stacks', { assetIds: [ids[0], ids[1]] })).body;
    await call(token, 'POST', '/stacks', { assetIds: [ids[2], ids[3]] });
    const all = await call(token, 'GET', '/stacks');
    expectResponse('/stacks', 'get', 200, all.body);
    expect(all.body).toHaveLength(2);
    const filtered = await call(token, 'GET', `/stacks?primaryAssetId=${ids[0]}`);
    expect(filtered.body.map((s: any) => s.id)).toEqual([s1.id]);
    expect((await call(token, 'GET', '/stacks?primaryAssetId=nope')).status).toBe(400);
    const one = await call(token, 'GET', `/stacks/${s1.id}`);
    expectResponse('/stacks/{id}', 'get', 200, one.body);
    expect(one.body.assets[0].tags).toEqual([]);
  });

  it('hides stacks from other users', async () => {
    const { token, other, ids } = await setup();
    const s = (await call(token, 'POST', '/stacks', { assetIds: [ids[0], ids[1]] })).body;
    expect((await call(other, 'GET', '/stacks')).body).toEqual([]);
    for (const [m, p, b] of [['GET', `/stacks/${s.id}`], ['PUT', `/stacks/${s.id}`, {}], ['DELETE', `/stacks/${s.id}`], ['DELETE', `/stacks/${s.id}/assets/${ids[1]}`], ['DELETE', '/stacks', { ids: [s.id] }]] as const) {
      expect((await call(other, m, p, b)).status, `${m} ${p}`).toBe(400);
    }
    expect(await stackIdOf(ids[0])).toBe(s.id);
  });

  it('updates the primary asset and validates membership', async () => {
    const { token, ids } = await setup();
    const s = (await call(token, 'POST', '/stacks', { assetIds: [ids[0], ids[1]] })).body;
    const upd = await call(token, 'PUT', `/stacks/${s.id}`, { primaryAssetId: ids[1] });
    expect(upd.status).toBe(200);
    expectResponse('/stacks/{id}', 'put', 200, upd.body);
    expect(upd.body.primaryAssetId).toBe(ids[1]);
    expect(upd.body.assets[0].id).toBe(ids[1]);
    expect((await call(token, 'PUT', `/stacks/${s.id}`, { primaryAssetId: ids[3] })).status).toBe(400);
    expect((await call(token, 'PUT', `/stacks/${s.id}`, { primaryAssetId: 'x' })).status).toBe(400);
    expect((await call(token, 'PUT', `/stacks/${s.id}`, {})).body.primaryAssetId).toBe(ids[1]);
  });

  it('removes a non-primary asset; the primary cannot be removed', async () => {
    const { token, ids } = await setup();
    const s = (await call(token, 'POST', '/stacks', { assetIds: [ids[0], ids[1], ids[2]] })).body;
    expect((await call(token, 'DELETE', `/stacks/${s.id}/assets/${ids[0]}`)).status).toBe(400);
    expect((await call(token, 'DELETE', `/stacks/${s.id}/assets/${ids[3]}`)).status).toBe(400);
    expect((await call(token, 'DELETE', `/stacks/${s.id}/assets/${ids[1]}`)).status).toBe(204);
    expect(await stackIdOf(ids[1])).toBeNull();
    expect((await call(token, 'GET', `/stacks/${s.id}`)).body.assets).toHaveLength(2);
  });

  it('deletes one stack and many stacks, releasing members', async () => {
    const { token, ids } = await setup();
    const s1 = (await call(token, 'POST', '/stacks', { assetIds: [ids[0], ids[1]] })).body;
    const s2 = (await call(token, 'POST', '/stacks', { assetIds: [ids[2], ids[3]] })).body;
    expect((await call(token, 'DELETE', `/stacks/${s1.id}`)).status).toBe(204);
    expect(await stackIdOf(ids[0])).toBeNull();
    expect(await stackIdOf(ids[1])).toBeNull();
    expect((await call(token, 'DELETE', '/stacks', { ids: [s2.id] })).status).toBe(204);
    expect(await stackIdOf(ids[3])).toBeNull();
    expect((await call(token, 'GET', '/stacks')).body).toEqual([]);
    expect((await call(token, 'DELETE', `/stacks/${s1.id}`)).status).toBe(400);
    expect((await call(token, 'DELETE', '/stacks', { ids: ['x'] })).status).toBe(400);
  });

  it('GET /assets/:id carries stack and tags', async () => {
    const { token, ids } = await setup();
    const s = (await call(token, 'POST', '/stacks', { assetIds: [ids[0], ids[1], ids[2]] })).body;
    const a = await call(token, 'GET', `/assets/${ids[1]}`);
    expectResponse('/assets/{id}', 'get', 200, a.body);
    expect(a.body.stack).toEqual({ id: s.id, primaryAssetId: ids[0], assetCount: 3 });
    expect((await call(token, 'GET', `/assets/${ids[3]}`)).body.stack).toBeNull();
  });
});

describe('stack sync', () => {
  const TYPES = ['AssetsV2', 'StacksV1'];

  it('emits StackV1 after AssetV2 and sets stackId on AssetV2 lines', async () => {
    const { token, ids } = await setup(3);
    await ackAll(token, await sync(token, TYPES));
    const s = (await call(token, 'POST', '/stacks', { assetIds: [ids[0], ids[1]] })).body;
    const lines = await sync(token, TYPES);
    expect(lines.map((l) => l.type)).toEqual(['AssetV2', 'AssetV2', 'StackV1', 'SyncCompleteV1']);
    for (const l of lines.slice(0, 2)) {
      expectSchema('SyncAssetV2', l.data);
      expect(l.data.stackId).toBe(s.id);
    }
    expectSchema('SyncStackV1', lines[2].data);
    expect(lines[2].data).toMatchObject({ id: s.id, primaryAssetId: ids[0] });
    expect(lines[2].ack).toMatch(/^StackV1\|00000000-0000-7000-8000-[0-9a-f]{12}$/);
    await ackAll(token, lines);
    expect((await sync(token, TYPES)).map((l) => l.type)).toEqual(['SyncCompleteV1']);
  });

  it('syncs primary changes, member removal and stack deletion', async () => {
    const { token, ids } = await setup(3);
    const s = (await call(token, 'POST', '/stacks', { assetIds: [ids[0], ids[1], ids[2]] })).body;
    await ackAll(token, await sync(token, TYPES));

    await call(token, 'PUT', `/stacks/${s.id}`, { primaryAssetId: ids[2] });
    let lines = await sync(token, TYPES);
    expect(lines.map((l) => l.type)).toEqual(['StackV1', 'SyncCompleteV1']);
    expect(lines[0].data.primaryAssetId).toBe(ids[2]);
    await ackAll(token, lines);

    await call(token, 'DELETE', `/stacks/${s.id}/assets/${ids[1]}`);
    lines = await sync(token, TYPES);
    expect(lines.map((l) => l.type)).toEqual(['AssetV2', 'SyncCompleteV1']);
    expect(lines[0].data).toMatchObject({ id: ids[1], stackId: null });
    await ackAll(token, lines);

    await call(token, 'DELETE', `/stacks/${s.id}`);
    lines = await sync(token, TYPES);
    expect(lines.map((l) => l.type)).toEqual(['AssetV2', 'AssetV2', 'StackDeleteV1', 'SyncCompleteV1']);
    expectSchema('SyncStackDeleteV1', lines[2].data);
    expect(lines[2].data.stackId).toBe(s.id);
    expect(lines.slice(0, 2).every((l) => l.data.stackId === null)).toBe(true);
    expect(lines[2].ack).toMatch(/^StackDeleteV1\|/);
  });

  it('does not leak stacks to other users', async () => {
    const { token, other, ids } = await setup(3);
    await call(token, 'POST', '/stacks', { assetIds: [ids[0], ids[1]] });
    expect((await sync(other, TYPES)).map((l) => l.type)).toEqual(['AssetV2', 'SyncCompleteV1']);
  });

  it('purging a primary asset promotes another member or dissolves the stack', async () => {
    const { token, ids } = await setup(4);
    const big = (await call(token, 'POST', '/stacks', { assetIds: [ids[0], ids[1], ids[2]] })).body;
    const pair = (await call(token, 'POST', '/stacks', { assetIds: [ids[3], ids[2]] })).body;
    expect(pair.assets).toHaveLength(2); // ids[2] moved out of `big`, which keeps ids[0] and ids[1]
    const row = (await env.DB.prepare('SELECT * FROM assets WHERE id = ?1').bind(ids[0]).first<AssetRow>())!;
    await env.DB.prepare("UPDATE assets SET deleted_at = '2020-01-01T00:00:00.000Z' WHERE id = ?1").bind(ids[0]).run();
    await purgeAssets(env, [{ ...row, deleted_at: '2020-01-01T00:00:00.000Z' }], new Date());
    expect((await call(token, 'GET', `/stacks/${big.id}`)).status).toBe(400); // one member would remain, so the stack is dissolved
    expect(await stackIdOf(ids[1])).toBeNull();
    const lines = await sync(token, ['StacksV1']);
    expect(lines.some((l) => l.type === 'StackDeleteV1' && l.data.stackId === big.id)).toBe(true);
  });

  it('purging a primary asset of a larger stack promotes the oldest remaining member', async () => {
    const { token, ids } = await setup(4);
    const s = (await call(token, 'POST', '/stacks', { assetIds: [ids[0], ids[1], ids[2]] })).body;
    await env.DB.prepare("UPDATE assets SET deleted_at = '2020-01-01T00:00:00.000Z' WHERE id = ?1").bind(ids[0]).run();
    const row = (await env.DB.prepare('SELECT * FROM assets WHERE id = ?1').bind(ids[0]).first<AssetRow>())!;
    await purgeAssets(env, [row], new Date());
    const after = await call(token, 'GET', `/stacks/${s.id}`);
    expect(after.body.primaryAssetId).toBe(ids[1]);
    expect(after.body.assets.map((a: any) => a.id)).toEqual([ids[1], ids[2]]);
  });

  it('caps create at 200 ids and bulk delete at 100 ids', async () => {
    const { token, ids } = await setup();
    const many = (n: number) => Array.from({ length: n }, () => crypto.randomUUID());
    expect((await call(token, 'POST', '/stacks', { assetIds: many(201) })).status).toBe(400);
    expect((await call(token, 'POST', '/stacks', { assetIds: many(200) })).status).toBe(400); // passes the cap, then fails on ownership
    expect((await call(token, 'DELETE', '/stacks', { ids: many(101) })).status).toBe(400);
    expect((await call(token, 'DELETE', '/stacks', { ids: many(100) })).status).toBe(400); // passes the cap, then fails on ownership
    expect(await stackIdOf(ids[0])).toBeNull();
  });

  it('treats primaryAssetId null as absent on update', async () => {
    const { token, ids } = await setup();
    const s = (await call(token, 'POST', '/stacks', { assetIds: [ids[0], ids[1]] })).body;
    const res = await call(token, 'PUT', `/stacks/${s.id}`, { primaryAssetId: null });
    expect(res.status).toBe(200);
    expect(res.body.primaryAssetId).toBe(ids[0]);
  });

  it('purge leaves a stack alone when the primary was restored after the purge read it', async () => {
    const { token, ids } = await setup();
    const s = (await call(token, 'POST', '/stacks', { assetIds: [ids[0], ids[1]] })).body;
    await env.DB.prepare("UPDATE assets SET deleted_at = '2020-01-01T00:00:00.000Z' WHERE id = ?1").bind(ids[0]).run();
    const row = (await env.DB.prepare('SELECT * FROM assets WHERE id = ?1').bind(ids[0]).first<AssetRow>())!;
    await env.DB.prepare('UPDATE assets SET deleted_at = NULL WHERE id = ?1').bind(ids[0]).run(); // restored before the commit
    await purgeAssets(env, [row], new Date());
    expect((await call(token, 'GET', `/stacks/${s.id}`)).body.primaryAssetId).toBe(ids[0]);
    expect(await stackIdOf(ids[1])).toBe(s.id);
  });
});
