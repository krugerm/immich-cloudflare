import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { findSession } from '../src/auth/session';
import { commit, tracked } from '../src/db/changes';
import { getCheckpoints, parseAck } from '../src/sync/acks';
import { streamSync } from '../src/sync/routes';
import { insertUser } from '../src/users/repo';
import { expectSchema } from './contract';
import { authHeaders, BASE, createUser, login, uploadAsset } from './helpers';

type Line = { type: string; data: Record<string, unknown>; ack: string };

const ALL = ['AuthUsersV2', 'UsersV1', 'PartnersV1', 'AssetsV2', 'PartnerAssetsV2', 'PartnerStacksV1', 'AssetExifsV1', 'PartnerAssetExifsV1'];
const PARTNER = ['PartnersV1', 'PartnerAssetsV2', 'PartnerStacksV1', 'PartnerAssetExifsV1'];

async function sync(token: string, types: string[]): Promise<Line[]> {
  const res = await SELF.fetch(`${BASE}/api/sync/stream`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify({ types }),
  });
  expect(res.status).toBe(200);
  return (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function postAcks(token: string, acks: unknown[]) {
  return SELF.fetch(`${BASE}/api/sync/ack`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify({ acks }),
  });
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

const call = (method: string, path: string, token: string, body?: unknown) =>
  SELF.fetch(`${BASE}/api${path}`, {
    method,
    headers: { ...authHeaders(token), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function addExif(assetId: string) {
  const owner = (await env.DB.prepare('SELECT owner_id FROM assets WHERE id = ?1').bind(assetId).first<string>('owner_id'))!;
  await commit(env.DB, [
    tracked("INSERT INTO asset_exif (asset_id, owner_id, make, update_id) VALUES (?1, ?2, 'Acme', :cursor)", assetId, owner),
  ]);
}

async function setup() {
  const admin = await createUser();
  const bob = await insertUser(env.DB, { email: 'bob@example.com', password: 'bob-pass-12', name: 'Bob', isAdmin: false });
  const carol = await insertUser(env.DB, { email: 'carol@example.com', password: 'carol-pass-1', name: 'Carol', isAdmin: false });
  const adminToken = await login();
  const bobToken = await login('bob@example.com', 'bob-pass-12');
  const carolToken = await login('carol@example.com', 'carol-pass-1');
  return { admin, bob, carol, adminToken, bobToken, carolToken };
}

const upload = async (token: string, size: number) => (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(size)), { filename: `f${size}.jpg` })).body.id;
const types = (lines: Line[]) => lines.map((l) => l.type);

describe('partner sync', () => {
  it('first sync sends partners, partner assets and exif in Immich order without backfill', async () => {
    const { admin, bob, adminToken, bobToken } = await setup();
    const a = await upload(adminToken, 100);
    await addExif(a);
    await call('POST', '/partners', adminToken, { sharedWithId: bob.id });
    const lines = await sync(bobToken, ALL);
    expect(types(lines)).toEqual(['AuthUserV2', 'UserV1', 'UserV1', 'UserV1', 'PartnerV1', 'PartnerAssetV2', 'PartnerAssetExifV1', 'SyncCompleteV1']);
    const partner = lines.find((l) => l.type === 'PartnerV1')!;
    expectSchema('SyncPartnerV1', partner.data);
    expect(partner.data).toEqual({ sharedById: admin.id, sharedWithId: bob.id, inTimeline: false });
    const asset = lines.find((l) => l.type === 'PartnerAssetV2')!;
    expectSchema('SyncAssetV2', asset.data);
    expect(asset.data).toMatchObject({ id: a, ownerId: admin.id, isFavorite: false });
    expectSchema('SyncAssetExifV1', lines.find((l) => l.type === 'PartnerAssetExifV1')!.data);
    // the server marks the backfill complete for the partners that exist now (Immich upsertBackfillCheckpoint)
    const session = (await findSession(env.DB, bobToken))!;
    const cps = await getCheckpoints(env.DB, session.session.id);
    expect(cps.get('PartnerAssetBackfillV2')).toMatch(/^00000000-0000-7000-8000-[0-9a-f]{12}\|complete$/);
    expect(cps.get('PartnerAssetExifBackfillV1')).toMatch(/\|complete$/);
  });

  it('the sharer sees the partner row and the partner assets stay with the shared-with side', async () => {
    const { bob, adminToken } = await setup();
    await upload(adminToken, 100);
    await call('POST', '/partners', adminToken, { sharedWithId: bob.id });
    expect(types(await sync(adminToken, PARTNER))).toEqual(['PartnerV1', 'SyncCompleteV1']);
  });

  it('a partner added after the client synced is backfilled, then marked complete with SyncAckV1', async () => {
    const { admin, bob, carol, adminToken, bobToken, carolToken } = await setup();
    const old1 = await upload(adminToken, 100);
    const old2 = await upload(adminToken, 101);
    await addExif(old1);
    await call('POST', '/partners', carolToken, { sharedWithId: bob.id });
    const c = await upload(carolToken, 102);
    await addExif(c);
    let lines = await sync(bobToken, PARTNER);
    expect(types(lines)).toEqual(['PartnerV1', 'PartnerAssetV2', 'PartnerAssetExifV1', 'SyncCompleteV1']);
    expect((await postAcks(bobToken, clientAcks(lines))).status).toBe(204);

    await call('POST', '/partners', adminToken, { sharedWithId: bob.id });
    lines = await sync(bobToken, PARTNER);
    expect(types(lines)).toEqual([
      'PartnerV1',
      'PartnerAssetBackfillV2', 'PartnerAssetBackfillV2', 'SyncAckV1',
      'PartnerAssetExifBackfillV1', 'SyncAckV1',
      'SyncCompleteV1',
    ]);
    const backfill = lines.filter((l) => l.type === 'PartnerAssetBackfillV2');
    expect(backfill.map((l) => l.data.id).sort()).toEqual([old1, old2].sort());
    backfill.forEach((l) => expectSchema('SyncAssetV2', l.data));
    expect(backfill[0].ack).toMatch(/^PartnerAssetBackfillV2\|00000000-0000-7000-8000-[0-9a-f]{12}\|00000000-0000-7000-8000-[0-9a-f]{12}$/);
    const done = lines.filter((l) => l.type === 'SyncAckV1');
    expect(done[0].ack).toMatch(/^PartnerAssetBackfillV2\|00000000-0000-7000-8000-[0-9a-f]{12}\|complete$/);
    expect(done[1].ack).toMatch(/^PartnerAssetExifBackfillV1\|.*\|complete$/);
    expect(done[0].data).toEqual({});
    expect(admin.id).not.toBe(carol.id);

    expect((await postAcks(bobToken, clientAcks(lines))).status).toBe(204);
    expect(types(await sync(bobToken, PARTNER))).toEqual(['SyncCompleteV1']);
  });

  it('backfill pages across partners and resumes mid-partner after an ack', async () => {
    const { bob, carol, adminToken, bobToken, carolToken } = await setup();
    const olds = [await upload(adminToken, 100), await upload(adminToken, 101), await upload(adminToken, 102)];
    await upload(carolToken, 103);
    const third = await insertUser(env.DB, { email: 'dan@example.com', password: 'dan-pass-123', name: 'Dan', isAdmin: false });
    const danToken = await login('dan@example.com', 'dan-pass-123');
    await call('POST', '/partners', danToken, { sharedWithId: bob.id });
    await upload(danToken, 104);
    await postAcks(bobToken, clientAcks(await sync(bobToken, PARTNER)));
    // two partners added after the checkpoint: carol (1 old asset) then admin (3 old assets)
    await call('POST', '/partners', carolToken, { sharedWithId: bob.id });
    await call('POST', '/partners', adminToken, { sharedWithId: bob.id });
    const session = (await findSession(env.DB, bobToken))!;
    const text = await new Response(streamSync(env.DB, session, ['PartnerAssetsV2'], { pageSize: 2 })).text();
    const lines = text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Line);
    expect(types(lines)).toEqual([
      'PartnerAssetBackfillV2', 'SyncAckV1',
      'PartnerAssetBackfillV2', 'PartnerAssetBackfillV2', 'PartnerAssetBackfillV2', 'SyncAckV1',
      'SyncCompleteV1',
    ]);
    expect(lines.slice(2, 5).map((l) => l.data.id).sort()).toEqual([...olds].sort());

    // ack the first backfill row of admin only: the next stream resends admin's remaining two
    await postAcks(bobToken, [lines[2].ack]);
    const again = await sync(bobToken, ['PartnerAssetsV2']);
    expect(types(again)).toEqual(['PartnerAssetBackfillV2', 'PartnerAssetBackfillV2', 'SyncAckV1', 'SyncCompleteV1']);
    expect(again.map((l) => l.data.id).slice(0, 2)).toEqual(lines.slice(3, 5).map((l) => l.data.id));
    expect(third.id).toBeTruthy();
    expect(carol.id).toBeTruthy();
  });

  it('removing a partner sends PartnerDeleteV1 to both sides; purged partner assets send PartnerAssetDeleteV1', async () => {
    const { admin, bob, adminToken, bobToken } = await setup();
    const a = await upload(adminToken, 100);
    await call('POST', '/partners', adminToken, { sharedWithId: bob.id });
    await postAcks(bobToken, clientAcks(await sync(bobToken, PARTNER)));
    await postAcks(adminToken, clientAcks(await sync(adminToken, PARTNER)));

    await commit(env.DB, [
      env.DB.prepare('DELETE FROM assets WHERE id = ?1').bind(a),
      tracked("INSERT INTO asset_audit (id, asset_id, owner_id, deleted_at) VALUES (:cursor, ?1, ?2, '2026-02-01T00:00:00.000Z')", a, admin.id),
    ]);
    let lines = await sync(bobToken, PARTNER);
    expect(types(lines)).toEqual(['PartnerAssetDeleteV1', 'SyncCompleteV1']);
    expectSchema('SyncAssetDeleteV1', lines[0].data);
    expect(lines[0].data).toEqual({ assetId: a });
    await postAcks(bobToken, clientAcks(lines));

    await call('DELETE', `/partners/${bob.id}`, adminToken);
    for (const token of [bobToken, adminToken]) {
      lines = await sync(token, PARTNER);
      expect(types(lines)).toEqual(['PartnerDeleteV1', 'SyncCompleteV1']);
      expectSchema('SyncPartnerDeleteV1', lines[0].data);
      expect(lines[0].data).toEqual({ sharedById: admin.id, sharedWithId: bob.id });
    }
  });

  it('inTimeline changes resend PartnerV1; strangers see nothing', async () => {
    const { admin, bob, adminToken, bobToken, carolToken } = await setup();
    await upload(adminToken, 100);
    await call('POST', '/partners', adminToken, { sharedWithId: bob.id });
    await postAcks(bobToken, clientAcks(await sync(bobToken, PARTNER)));
    await call('PUT', `/partners/${admin.id}`, bobToken, { inTimeline: true });
    const lines = await sync(bobToken, PARTNER);
    expect(types(lines)).toEqual(['PartnerV1', 'SyncCompleteV1']);
    expect(lines[0].data.inTimeline).toBe(true);
    expect(types(await sync(carolToken, PARTNER))).toEqual(['SyncCompleteV1']);
  });

  it('accepts 3-segment acks for backfill types only', async () => {
    const { bobToken } = await setup();
    const c = '00000000-0000-7000-8000-000000000001';
    expect(parseAck(`PartnerAssetBackfillV2|${c}|complete`)).toEqual({ type: 'PartnerAssetBackfillV2', id: c, extraId: 'complete' });
    expect(parseAck(`PartnerAssetExifBackfillV1|${c}|${c}`).extraId).toBe(c);
    for (const bad of [`PartnerAssetV2|${c}|complete`, `PartnerAssetBackfillV2|${c}|nope`, `PartnerAssetBackfillV2|bad|complete`, `PartnerAssetBackfillV2|${c}|${c}|x`]) {
      expect((await postAcks(bobToken, [bad])).status).toBe(400);
    }
    expect((await postAcks(bobToken, [`PartnerAssetBackfillV2|${c}|complete`])).status).toBe(204);
    const stored = await env.DB.prepare("SELECT ack FROM sync_checkpoints WHERE entity_type = 'PartnerAssetBackfillV2'").first<string>('ack');
    expect(stored).toBe(`PartnerAssetBackfillV2|${c}|complete`);
  });
});
