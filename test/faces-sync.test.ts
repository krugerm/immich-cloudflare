import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { commit, tracked } from '../src/db/changes';
import type { AssetRow } from '../src/db/rows';
import { storeFaces } from '../src/faces/store';
import type { MlFace } from '../src/ml/contract';
import { expectSchema } from './contract';
import { authHeaders, BASE, createUser, login, uploadAsset } from './helpers';

type Line = { type: string; data: Record<string, unknown>; ack: string };

async function sync(token: string, types: string[]): Promise<Line[]> {
  const res = await SELF.fetch(`${BASE}/api/sync/stream`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify({ types }),
  });
  return (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Line);
}

async function ackAll(token: string, lines: Line[]) {
  const last = new Map<string, string>();
  for (const l of lines) if (l.type !== 'SyncCompleteV1') last.set(l.type, l.ack);
  await SELF.fetch(`${BASE}/api/sync/ack`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify({ acks: [...last.values()] }),
  });
}

const SCHEMAS: Record<string, string> = {
  PersonV1: 'SyncPersonV1',
  PersonDeleteV1: 'SyncPersonDeleteV1',
  AssetFaceV3: 'SyncAssetFaceV3',
  AssetFaceDeleteV1: 'SyncAssetFaceDeleteV1',
};

function expectLines(lines: Line[]) {
  for (const l of lines) if (SCHEMAS[l.type]) expectSchema(SCHEMAS[l.type], l.data);
}

const quietHub = { idFromName: () => ({}), get: () => ({ fetch: async () => new Response(null, { status: 204 }) }) };
const hubEnv = { ...env, CLUSTER_HUB: quietHub } as unknown as Env;

let n = 0;
async function userWithAsset() {
  const email = `fsync${++n}@example.com`;
  const user = await createUser({ email });
  const token = await login(email);
  const id = (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(100)))).body.id as string;
  await env.DB.prepare("UPDATE assets SET status = 'ready' WHERE id = ?1").bind(id).run();
  const asset = (await env.DB.prepare('SELECT * FROM assets WHERE id = ?1').bind(id).first<AssetRow>())!;
  return { userId: user.id, token, asset };
}

const face = (x: number): MlFace => ({
  boundingBox: { x1: x, y1: 100, x2: x + 200, y2: 300 },
  score: 0.9,
  embedding: Array.from({ length: 512 }, (_, i) => Math.cos(x + i)),
});

async function createPerson(ownerId: string, faceId: string | null, birthDate: string | null = null) {
  const groupId = crypto.randomUUID();
  const now = new Date().toISOString();
  await commit(env.DB, [
    env.DB.prepare('INSERT INTO person_groups (id, cluster_group_id, created_at) VALUES (?1, ?2, ?3)').bind(groupId, ownerId, now),
    tracked(
      `INSERT INTO people (owner_id, person_group_id, name, birth_date, face_id, created_at, updated_at, update_id)
       VALUES (?1, ?2, 'Ada', ?3, ?4, ?5, ?5, :cursor)`,
      ownerId, groupId, birthDate, faceId, now,
    ),
  ]);
  return groupId;
}

describe('faces and people sync', () => {
  it('streams PersonV1 and AssetFaceV3 lines that match the contract, in request order', async () => {
    const { userId, token, asset } = await userWithAsset();
    const [faceId] = await storeFaces(hubEnv, asset, { clip: null, faces: [face(100)], imageWidth: 1440, imageHeight: 1080 });
    const groupId = await createPerson(userId, faceId, '1990-05-17');
    await commit(env.DB, [tracked('UPDATE asset_faces SET person_group_id = ?2, update_id = :cursor WHERE id = ?1', faceId, groupId)]);

    const lines = await sync(token, ['AssetFacesV3', 'PeopleV1']);
    expectLines(lines);
    expect(lines.map((l) => l.type)).toEqual(['PersonV1', 'AssetFaceV3', 'SyncCompleteV1']);
    expect(lines[0].data).toMatchObject({ id: groupId, ownerId: userId, name: 'Ada', birthDate: '1990-05-17T00:00:00.000Z', faceAssetId: faceId, isHidden: false });
    expect(lines[1].data).toEqual({
      id: faceId, assetId: asset.id, personId: groupId, imageWidth: 1440, imageHeight: 1080,
      boundingBoxX1: 100, boundingBoxY1: 100, boundingBoxX2: 300, boundingBoxY2: 300,
      sourceType: 'machine-learning', deletedAt: null, isVisible: true,
    });

    await ackAll(token, lines);
    expect((await sync(token, ['AssetFacesV3', 'PeopleV1'])).map((l) => l.type)).toEqual(['SyncCompleteV1']);
  });

  it('sends a vanished face as AssetFaceDeleteV1, a user-deleted face with deletedAt, and person deletes', async () => {
    const { userId, token, asset } = await userWithAsset();
    const [vanished, userDeleted] = await storeFaces(hubEnv, asset, { clip: null, faces: [face(100), face(700)], imageWidth: 1440, imageHeight: 1080 });
    const groupId = await createPerson(userId, null);
    await ackAll(token, await sync(token, ['PeopleV1', 'AssetFacesV3']));

    // detection no longer finds the first face; the user soft-deletes the second (Task E's DELETE /faces)
    await storeFaces(hubEnv, asset, { clip: null, faces: [face(700)], imageWidth: 1440, imageHeight: 1080 });
    await commit(env.DB, [
      tracked('UPDATE asset_faces SET deleted_at = ?2, update_id = :cursor WHERE id = ?1', userDeleted, new Date().toISOString()),
      tracked('INSERT INTO person_audit (id, person_group_id, owner_id, deleted_at) VALUES (:cursor, ?1, ?2, ?3)', groupId, userId, new Date().toISOString()),
    ]);

    const lines = await sync(token, ['PeopleV1', 'AssetFacesV3']);
    expectLines(lines);
    expect(lines.map((l) => l.type)).toEqual(['PersonDeleteV1', 'AssetFaceDeleteV1', 'AssetFaceV3', 'SyncCompleteV1']);
    expect(lines[0].data).toEqual({ personId: groupId });
    expect(lines[1].data).toEqual({ assetFaceId: vanished });
    expect(lines[2].data).toMatchObject({ id: userDeleted });
    expect(lines[2].data.deletedAt).toEqual(expect.any(String));
  });

  it('never sends another user\'s faces or people', async () => {
    const a = await userWithAsset();
    const b = await userWithAsset();
    const [faceId] = await storeFaces(hubEnv, a.asset, { clip: null, faces: [face(500)], imageWidth: 1440, imageHeight: 1080 });
    await createPerson(a.userId, faceId);
    const lines = await sync(b.token, ['PeopleV1', 'AssetFacesV3']);
    expect(lines.map((l) => l.type)).toEqual(['SyncCompleteV1']);
  });
});
