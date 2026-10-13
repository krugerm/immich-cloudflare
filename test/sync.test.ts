import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { commit, tracked } from '../src/db/changes';
import { findSession } from '../src/auth/session';
import { getCheckpoints } from '../src/sync/acks';
import { streamSync } from '../src/sync/routes';
import { expectSchema } from './contract';
import { authHeaders, BASE, createUser, login, uploadAsset } from './helpers';

type Line = { type: string; data: Record<string, unknown>; ack: string };

async function sync(token: string, types: string[]): Promise<Line[]> {
  const res = await SELF.fetch(`${BASE}/api/sync/stream`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'content-type': 'application/json', accept: 'application/jsonlines+json' },
    body: JSON.stringify({ types }),
  });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('application/jsonlines+json');
  return (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function ack(token: string, acks: string[]) {
  const res = await SELF.fetch(`${BASE}/api/sync/ack`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify({ acks }),
  });
  expect(res.status).toBeLessThan(300);
}

/** Mimics the client: ack the last line of each run of same-type lines. */
function clientAcks(lines: Line[]): string[] {
  const out: string[] = [];
  lines.forEach((l, i) => {
    if (l.type === 'SyncCompleteV1') return;
    if (i === lines.length - 1 || lines[i + 1].type !== l.type) out.push(l.ack);
  });
  return out;
}

const ALL = ['AuthUsersV2', 'UsersV1', 'AssetsV2', 'AssetExifsV1', 'MemoriesV2', 'AssetOcrV1'];

describe('sync stream', () => {
  it('emits own user, users, assets in Immich order, ending with SyncCompleteV1', async () => {
    await createUser();
    const token = await login();
    await uploadAsset(token, crypto.getRandomValues(new Uint8Array(100)));
    const lines = await sync(token, ALL);
    expect(lines.map((l) => l.type)).toEqual(['AuthUserV2', 'UserV1', 'AssetV2', 'SyncCompleteV1']);
    expectSchema('SyncAuthUserV2', lines[0].data);
    expectSchema('SyncUserV1', lines[1].data);
    expect(lines[0].data.avatarColor).toBeNull(); // phase 1 never sets a colour explicitly
    expect(lines[1].data.avatarColor).toBeNull();
    expectSchema('SyncAssetV2', lines[2].data);
    expect(lines[2].ack).toMatch(/^AssetV2\|00000000-0000-7000-8000-[0-9a-f]{12}$/);
    expect(lines[3].ack).toMatch(/^SyncCompleteV1\|/);
  });

  it('acked rows are not sent again; new and changed rows are', async () => {
    await createUser();
    const token = await login();
    const a = await uploadAsset(token, crypto.getRandomValues(new Uint8Array(100)));
    await ack(token, clientAcks(await sync(token, ALL)));
    expect((await sync(token, ALL)).map((l) => l.type)).toEqual(['SyncCompleteV1']);
    await commit(env.DB, [tracked('UPDATE assets SET is_favorite = 1, update_id = :cursor WHERE id = ?1', a.body.id)]);
    const lines = await sync(token, ALL);
    expect(lines.map((l) => l.type)).toEqual(['AssetV2', 'SyncCompleteV1']);
    expect(lines[0].data.isFavorite).toBe(true);
  });

  it('trash is an AssetV2 with deletedAt, purge is an AssetDeleteV1', async () => {
    await createUser();
    const token = await login();
    const a = await uploadAsset(token, crypto.getRandomValues(new Uint8Array(100)));
    await ack(token, clientAcks(await sync(token, ALL)));
    await commit(env.DB, [tracked("UPDATE assets SET deleted_at = '2026-01-01T00:00:00.000Z', update_id = :cursor WHERE id = ?1", a.body.id)]);
    let lines = await sync(token, ALL);
    expect(lines[0].type).toBe('AssetV2');
    expect(lines[0].data.deletedAt).toBe('2026-01-01T00:00:00.000Z');
    await ack(token, clientAcks(lines));
    const owner = (await env.DB.prepare('SELECT owner_id FROM assets').first<string>('owner_id'))!;
    await commit(env.DB, [
      env.DB.prepare('DELETE FROM assets WHERE id = ?1').bind(a.body.id),
      tracked("INSERT INTO asset_audit (id, asset_id, owner_id, deleted_at) VALUES (:cursor, ?1, ?2, '2026-02-01T00:00:00.000Z')", a.body.id, owner),
    ]);
    lines = await sync(token, ALL);
    expect(lines.map((l) => l.type)).toEqual(['AssetDeleteV1', 'SyncCompleteV1']);
    expect(lines[0].data).toEqual({ assetId: a.body.id });
  });

  it('rows sharing a commit straddle a page boundary and both arrive', async () => {
    await createUser();
    const token = await login();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await uploadAsset(token, crypto.getRandomValues(new Uint8Array(50 + i)))).body.id);
    await ack(token, clientAcks(await sync(token, ALL)));
    await commit(env.DB, ids.map((id) => tracked('UPDATE assets SET is_favorite = 1, update_id = :cursor WHERE id = ?1', id)));
    const session = (await findSession(env.DB, token))!;
    const text = await new Response(streamSync(env.DB, session, ['AssetsV2'], { pageSize: 2 })).text();
    const got = text.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.type === 'AssetV2').map((l) => l.data.id);
    expect(got.sort()).toEqual([...ids].sort());
  });

  it('stream stops at query budget and resumes', async () => {
    await createUser();
    const token = await login();
    for (let i = 0; i < 5; i++) await uploadAsset(token, crypto.getRandomValues(new Uint8Array(60 + i)));
    const session = (await findSession(env.DB, token))!;
    // Budget 4 = 2 setup queries + the empty AssetDeleteV1 page + one 2-row AssetV2 page per stream.
    const read = async () =>
      (await new Response(streamSync(env.DB, session, ['AssetsV2'], { pageSize: 2, queryBudget: 4 })).text())
        .split('\n').filter(Boolean).map((l) => JSON.parse(l) as Line);
    const seen: string[] = [];
    let streams = 0;
    for (;;) {
      const lines = await read();
      streams++;
      seen.push(...lines.filter((l) => l.type === 'AssetV2').map((l) => l.data.id as string));
      if (lines.at(-1)?.type === 'SyncCompleteV1') break;
      await ack(token, clientAcks(lines));
      if (streams > 10) throw new Error('sync made no progress');
    }
    expect(streams).toBe(3);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it('SyncResetV1 ack clears checkpoints so the next stream is a full resync', async () => {
    await createUser();
    const token = await login();
    await uploadAsset(token, crypto.getRandomValues(new Uint8Array(100)));
    await ack(token, clientAcks(await sync(token, ALL)));
    await ack(token, ['SyncResetV1|reset']);
    const lines = await sync(token, ALL);
    expect(lines.map((l) => l.type)).toEqual(['AuthUserV2', 'UserV1', 'AssetV2', 'SyncCompleteV1']);
  });

  it('reset:true in the request clears checkpoints first', async () => {
    await createUser();
    const token = await login();
    await uploadAsset(token, crypto.getRandomValues(new Uint8Array(100)));
    await ack(token, clientAcks(await sync(token, ALL)));
    const res = await SELF.fetch(`${BASE}/api/sync/stream`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ types: ALL, reset: true }),
    });
    expect((await res.text()).split('\n').filter(Boolean)).toHaveLength(4);
  });

  it('DELETE /sync/ack accepts unimplemented entity types; unknown types are 400', async () => {
    await createUser();
    const token = await login();
    const del = await SELF.fetch(`${BASE}/api/sync/ack`, {
      method: 'DELETE',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ types: ['AssetV1', 'PartnerAssetV1', 'AlbumAssetCreateV1'] }),
    });
    expect(del.status).toBeLessThan(300);
    const bad = await SELF.fetch(`${BASE}/api/sync/ack`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ acks: ['NotAType|x'] }),
    });
    expect(bad.status).toBe(400);
  });

  it('rejects malformed ack ids with 400 and stores nothing', async () => {
    await createUser();
    const token = await login();
    const post = (acks: unknown) =>
      SELF.fetch(`${BASE}/api/sync/ack`, { method: 'POST', headers: { ...authHeaders(token), 'content-type': 'application/json' }, body: JSON.stringify({ acks }) });
    for (const bad of ['AssetV2|not-a-cursor', 'AssetV2|', 'AssetV2', 'Bogus|00000000-0000-7000-8000-000000000001', 'SyncResetV1|other', 42]) {
      expect((await post([bad])).status).toBe(400);
    }
    expect((await post([ 'AssetV2|00000000-0000-7000-8000-000000000001', 'AssetV2|zzz' ])).status).toBe(400);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM sync_checkpoints').first('n')).toBe(0);
    expect((await post(['AssetV2|00000000-0000-7000-8000-00000000000a', 'SyncCompleteV1|2026-01-01T00:00:00.000Z'])).status).toBe(204);
  });

  it('skips unparseable stored checkpoints instead of throwing', async () => {
    await createUser();
    const token = await login();
    const session = (await env.DB.prepare('SELECT id FROM sessions').first<{ id: string }>())!.id;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO sync_checkpoints (session_id, entity_type, ack) VALUES (?1, 'AssetV2', 'garbage')").bind(session),
      env.DB.prepare("INSERT INTO sync_checkpoints (session_id, entity_type, ack) VALUES (?1, 'UserV1', 'UserV1|00000000-0000-7000-8000-000000000005')").bind(session),
    ]);
    const map = await getCheckpoints(env.DB, session);
    expect([...map]).toEqual([['UserV1', '00000000-0000-7000-8000-000000000005']]);
    expect((await sync(token, ALL)).at(-1)?.type).toBe('SyncCompleteV1');
  });
});
