import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { AssetRow } from '../src/db/rows';
import { drainVectorDeletes, iou, reconcileFaces, storeFaces, type FaceRow } from '../src/faces/store';
import { faceCrop, personThumbKey, renderPersonThumbnail, type FaceCropper } from '../src/faces/thumbs';
import { fromBlob, MlUnavailableError, type MlFace, type MlImageResult } from '../src/ml/contract';
import { processMl } from '../src/ml/job';
import { fakeVectorStore } from '../src/ml/vectors';
import { thumbKey } from '../src/process/thumbs';
import { createUser, login, uploadAsset } from './helpers';

function embedding(seed: number): number[] {
  return Array.from({ length: 512 }, (_, i) => Math.sin(seed * 31 + i));
}

function face(box: [number, number, number, number], seed = 1): MlFace {
  return { boundingBox: { x1: box[0], y1: box[1], x2: box[2], y2: box[3] }, score: 0.9, embedding: embedding(seed) };
}

function result(faces: MlFace[], imageWidth = 1440, imageHeight = 1080): MlImageResult {
  return { clip: null, faces, imageWidth, imageHeight };
}

/** A ClusterHub namespace that records the requests it receives. */
function fakeHub() {
  const calls: Array<{ name: string; path: string; body: { faceIds: string[] } }> = [];
  const hub = { calls, failing: false, env: undefined as unknown as Env };
  const ns = {
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => ({
      fetch: async (url: string, init: RequestInit) => {
        calls.push({ name: id.name, path: new URL(url).pathname, body: JSON.parse(String(init.body)) });
        if (hub.failing) throw new Error('hub down');
        return new Response(null, { status: 204 });
      },
    }),
  };
  hub.env = { ...env, CLUSTER_HUB: ns } as unknown as Env;
  return hub;
}

let users = 0;
async function readyAsset(): Promise<AssetRow> {
  const email = `faces${++users}@example.com`;
  await createUser({ email });
  const token = await login(email);
  const id = (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(100)))).body.id as string;
  await env.DB.prepare("UPDATE assets SET status = 'ready' WHERE id = ?1").bind(id).run();
  return (await env.DB.prepare('SELECT * FROM assets WHERE id = ?1').bind(id).first<AssetRow>())!;
}

const facesOf = async (assetId: string) =>
  (await env.DB.prepare('SELECT * FROM asset_faces WHERE asset_id = ?1 ORDER BY x1').bind(assetId).all<FaceRow>()).results;

const embeddingOf = (faceId: string) =>
  env.DB.prepare('SELECT embedding FROM face_embeddings WHERE face_id = ?1').bind(faceId).first<{ embedding: ArrayBuffer }>();

async function insertFace(a: AssetRow, source: 'manual' | 'exif' | 'machine-learning', box: [number, number, number, number], size = [1440, 1080], deletedAt: string | null = null) {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO asset_faces (id, asset_id, owner_id, cluster_group_id, image_width, image_height, x1, y1, x2, y2, source_type, deleted_at, updated_at, update_id)
     VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, '2026-01-01T00:00:00.000Z', '00000000-0000-7000-8000-000000000001')`,
  ).bind(id, a.id, a.owner_id, size[0], size[1], ...box, source, deletedAt).run();
  return id;
}

describe('faceCrop', () => {
  it('adds a 10% margin around the face centre, scaled to the decoded image', () => {
    // box 100x100 centred at (200, 200) on a 1000x800 image, decoded at half size
    const r = faceCrop({ old: { width: 1000, height: 800 }, new: { width: 500, height: 400 } }, { x1: 150, y1: 150, x2: 250, y2: 250 });
    // scaled box 50x50 centred at (100, 100): half-size floor(25 * 1.1) = 27
    expect(r).toEqual({ x: 73, y: 73, width: 54, height: 54 });
  });

  it('clamps boxes past the edge and keeps the square inside the image', () => {
    const r = faceCrop({ old: { width: 1000, height: 800 }, new: { width: 1000, height: 800 } }, { x1: -40, y1: 700, x2: 60, y2: 900 });
    // clamped to x 0..60, y 700..800: centre (30, 750); the left edge limits the half-size to 30
    expect(r).toEqual({ x: 0, y: 720, width: 60, height: 60 });
  });
});

describe('renderPersonThumbnail', () => {
  it('crops the feature face from the preview, stores people/<group>.jpeg and bumps the person row', async () => {
    const a = await readyAsset();
    const [faceId] = await storeFaces(fakeHub().env, a, result([face([100, 100, 300, 300])]));
    const groupId = crypto.randomUUID();
    const now = '2026-01-01T00:00:00.000Z';
    await env.DB.batch([
      env.DB.prepare('INSERT INTO person_groups (id, cluster_group_id, created_at) VALUES (?1, ?2, ?3)').bind(groupId, a.owner_id, now),
      env.DB.prepare(
        `INSERT INTO people (owner_id, person_group_id, face_id, created_at, updated_at, update_id) VALUES (?1, ?2, ?3, ?4, ?4, '00000000-0000-7000-8000-000000000001')`,
      ).bind(a.owner_id, groupId, faceId, now),
    ]);
    await env.MEDIA.put(thumbKey(a.id, 'preview'), new Uint8Array([0xff, 0xd8, 1]));
    const calls: Array<{ rect: unknown; size: number }> = [];
    const cropper: FaceCropper = {
      info: async () => ({ width: 720, height: 540 }),
      crop: async (_input, rect, size) => {
        calls.push({ rect, size });
        return new Uint8Array([0xff, 0xd8, 9]);
      },
    };

    expect(await renderPersonThumbnail(env, groupId, cropper)).toBe(true);
    expect(calls).toEqual([{ rect: { x: 45, y: 45, width: 110, height: 110 }, size: 250 }]);
    const obj = await env.MEDIA.get(personThumbKey(groupId));
    expect(obj?.httpMetadata?.contentType).toBe('image/jpeg');
    expect(new Uint8Array(await obj!.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xd8, 9]));
    const person = await env.DB.prepare('SELECT thumbnail_key, updated_at, update_id FROM people WHERE person_group_id = ?1').bind(groupId).first<{ thumbnail_key: string; updated_at: string; update_id: string }>();
    expect(person!.thumbnail_key).toBe(`people/${groupId}.jpeg`);
    expect(person!.updated_at > now).toBe(true);
    expect(person!.update_id > '00000000-0000-7000-8000-000000000001').toBe(true);
  });

  it('returns false when the person has no live feature face', async () => {
    const cropper: FaceCropper = { info: async () => ({ width: 1, height: 1 }), crop: async () => new Uint8Array() };
    expect(await renderPersonThumbnail(env, crypto.randomUUID(), cropper)).toBe(false);
  });
});

describe('iou', () => {
  it('matches Immich for identical, disjoint and half-overlapping boxes', () => {
    const a = { x1: 0, y1: 0, x2: 10, y2: 10 };
    expect(iou(a, a)).toBe(1);
    expect(iou(a, { x1: 20, y1: 20, x2: 30, y2: 30 })).toBe(0);
    expect(iou(a, { x1: 5, y1: 0, x2: 15, y2: 10 })).toBeCloseTo(50 / 150);
  });
});

describe('reconcileFaces', () => {
  const stored = (over: Partial<FaceRow>): FaceRow => ({
    id: crypto.randomUUID(), asset_id: 'a', owner_id: 'u', cluster_group_id: 'u', person_group_id: null,
    image_width: 720, image_height: 540, x1: 100, y1: 100, x2: 200, y2: 200, score: 0.9,
    source_type: 'machine-learning', is_visible: 1, deleted_at: null, updated_at: '', update_id: '', ...over,
  });

  it('scales detected boxes into each stored face\'s pixel space before matching', () => {
    const ml = stored({});
    // the same face found on a preview twice the size
    const changes = reconcileFaces([ml], result([face([200, 200, 400, 400])], 1440, 1080));
    expect(changes).toEqual({ added: [], embedded: [], removed: [] });
  });

  it('adds unmatched faces, embeds manual matches and removes vanished machine faces', () => {
    const vanished = stored({ x1: 500, x2: 600 });
    const manual = stored({ source_type: 'manual', x1: 300, x2: 400 });
    const ids = ['new-1'];
    const changes = reconcileFaces([vanished, manual], result([face([600, 200, 800, 400]), face([10, 10, 50, 50])]), () => ids.shift()!);
    expect(changes).toEqual({ added: [{ index: 1, id: 'new-1' }], embedded: [{ index: 0, id: manual.id }], removed: [vanished.id] });
  });

  it('does not re-create a face the user deleted; removes it once it is no longer detected (as Immich)', () => {
    const deleted = stored({ deleted_at: '2026-01-01T00:00:00.000Z' });
    expect(reconcileFaces([deleted], result([face([200, 200, 400, 400])]))).toEqual({ added: [], embedded: [], removed: [] });
    expect(reconcileFaces([deleted], result([]))).toEqual({ added: [], embedded: [], removed: [deleted.id] });
  });
});

describe('storeFaces', () => {
  it('inserts faces with embeddings and vectors in the owner\'s namespace, then notifies the ClusterHub', async () => {
    const a = await readyAsset();
    const hub = fakeHub();
    const added = await storeFaces(hub.env, a, result([face([100, 120, 300, 330], 1), face([700, 100, 900, 300], 2)]));
    expect(added).toHaveLength(2);

    const rows = await facesOf(a.id);
    expect(rows.map((r) => [r.x1, r.y1, r.x2, r.y2, r.image_width, r.image_height, r.source_type, r.owner_id, r.cluster_group_id, r.person_group_id])).toEqual([
      [100, 120, 300, 330, 1440, 1080, 'machine-learning', a.owner_id, a.owner_id, null],
      [700, 100, 900, 300, 1440, 1080, 'machine-learning', a.owner_id, a.owner_id, null],
    ]);
    expect(new Set(rows.map((r) => r.update_id)).size).toBe(2);
    const stored = fromBlob((await embeddingOf(rows[0].id))!.embedding);
    expect(stored[5]).toBeCloseTo(embedding(1)[5], 5);

    const matches = await fakeVectorStore('face').query(embedding(2), { topK: 1, namespace: a.owner_id });
    expect(matches[0].id).toBe(rows[1].id);
    expect(hub.calls).toEqual([{ name: a.owner_id, path: '/faces', body: { faceIds: added } }]);
    expect(await env.DB.prepare('SELECT faces_recognized_at FROM assets WHERE id = ?1').bind(a.id).first('faces_recognized_at')).toBeTruthy();
  });

  it('keeps matched faces on a re-run and sends only unassigned machine faces to the hub', async () => {
    const a = await readyAsset();
    const hub = fakeHub();
    const [first, second] = await storeFaces(hub.env, a, result([face([100, 100, 300, 300]), face([700, 100, 900, 300])]));
    const groupId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO person_groups (id, cluster_group_id, created_at) VALUES (?1, ?2, ?3)').bind(groupId, a.owner_id, '2026-01-01T00:00:00.000Z'),
      env.DB.prepare('UPDATE asset_faces SET person_group_id = ?2 WHERE id = ?1').bind(first, groupId),
    ]);
    const before = await facesOf(a.id);
    const again = await storeFaces(hub.env, a, result([face([104, 98, 302, 305]), face([700, 100, 900, 300])]));
    expect(again).toEqual([]);
    expect(await facesOf(a.id)).toEqual(before);
    expect(hub.calls.map((c) => c.body.faceIds)).toEqual([[first, second], [second]]);
  });

  it('throws when the hub is unreachable, and the retry sends the same faces', async () => {
    const a = await readyAsset();
    const hub = fakeHub();
    hub.failing = true;
    await expect(storeFaces(hub.env, a, result([face([100, 100, 300, 300])]))).rejects.toThrow('hub down');
    const [row] = await facesOf(a.id);
    hub.failing = false;
    await storeFaces(hub.env, a, result([face([100, 100, 300, 300])]));
    expect(hub.calls.map((c) => c.body.faceIds)).toEqual([[row.id], [row.id]]);
  });

  it('writes no vectors when the D1 commit fails', async () => {
    const a = await readyAsset();
    const hub = fakeHub();
    const db = { prepare: (sql: string) => env.DB.prepare(sql), batch: async () => { throw new Error('d1 down'); } };
    const broken = { ...hub.env, DB: db } as unknown as Env;
    await expect(storeFaces(broken, a, result([face([100, 100, 300, 300], 7)]))).rejects.toThrow('d1 down');
    expect(await facesOf(a.id)).toHaveLength(0);
    const near = await fakeVectorStore('face').query(embedding(7), { topK: 1, namespace: a.owner_id });
    expect(near.filter((m) => m.score > 0.999)).toEqual([]);
    expect(hub.calls).toEqual([]);
  });

  it('restores vectors on the next run after an upsert failed', async () => {
    const a = await readyAsset();
    const hub = fakeHub();
    const failingIndex = { upsert: async () => { throw new Error('vectorize down'); } };
    const broken = { ...hub.env, TEST_FAKE_VECTORS: 'false', FACE_INDEX: failingIndex } as unknown as Env;
    await expect(storeFaces(broken, a, result([face([100, 100, 300, 300], 8)]))).rejects.toThrow('vectorize down');
    const [row] = await facesOf(a.id);
    expect((await fakeVectorStore('face').query(embedding(8), { topK: 1, namespace: a.owner_id }))[0]?.id).not.toBe(row.id);

    expect(await storeFaces(hub.env, a, result([face([100, 100, 300, 300], 8)]))).toEqual([]);
    const [match] = await fakeVectorStore('face').query(embedding(8), { topK: 1, namespace: a.owner_id });
    expect(match.id).toBe(row.id);
    expect(match.score).toBeCloseTo(1, 5);
    expect(hub.calls.map((c) => c.body.faceIds)).toEqual([[row.id]]);
  });

  it('hard-deletes machine faces no longer detected, with an audit row, and drops their vectors; manual and EXIF faces stay', async () => {
    const a = await readyAsset();
    const hub = fakeHub();
    const [gone] = await storeFaces(hub.env, a, result([face([100, 100, 300, 300], 3)]));
    const manual = await insertFace(a, 'manual', [600, 100, 800, 300]);
    const exif = await insertFace(a, 'exif', [1000, 100, 1200, 300]);

    await storeFaces(hub.env, a, result([face([600, 100, 800, 300], 4)]));
    const rows = new Map((await facesOf(a.id)).map((r) => [r.id, r]));
    expect(rows.has(gone)).toBe(false);
    expect(await embeddingOf(gone)).toBeNull();
    const audit = await env.DB.prepare('SELECT * FROM asset_face_audit WHERE face_id = ?1').bind(gone)
      .first<{ asset_id: string; owner_id: string; cluster_group_id: string }>();
    expect(audit).toMatchObject({ asset_id: a.id, owner_id: a.owner_id, cluster_group_id: a.owner_id });
    expect((await fakeVectorStore('face').query(embedding(3), { topK: 5, namespace: a.owner_id })).map((m) => m.id)).not.toContain(gone);

    // the overlapped manual face gets the embedding and a vector; the EXIF face is untouched
    expect(rows.get(manual)!.source_type).toBe('manual');
    expect(await embeddingOf(manual)).not.toBeNull();
    expect((await fakeVectorStore('face').query(embedding(4), { topK: 1, namespace: a.owner_id }))[0].id).toBe(manual);
    expect(rows.get(exif)!.deleted_at).toBeNull();
    expect(await embeddingOf(exif)).toBeNull();
    expect(rows.size).toBe(2);
  });

  it('writes one audit row when two overlapping runs remove the same face', async () => {
    const a = await readyAsset();
    const hub = fakeHub();
    const [gone] = await storeFaces(hub.env, a, result([face([100, 100, 300, 300])]));
    const stale = await facesOf(a.id);
    await storeFaces(hub.env, a, result([]));
    // the racing run read the faces before the first run committed
    const staleDb = {
      prepare: (sql: string) =>
        sql.startsWith('SELECT * FROM asset_faces WHERE asset_id')
          ? { bind: () => ({ all: async () => ({ results: stale }) }) }
          : env.DB.prepare(sql),
      batch: (s: D1PreparedStatement[]) => env.DB.batch(s),
    };
    await storeFaces({ ...hub.env, DB: staleDb } as unknown as Env, a, result([]));
    const audits = await env.DB.prepare('SELECT COUNT(*) AS n FROM asset_face_audit WHERE face_id = ?1').bind(gone).first<number>('n');
    expect(audits).toBe(1);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM vector_delete_queue WHERE vector_id = ?1').bind(gone).first<number>('n')).toBe(0);
  });

  it('keeps the vector delete queued when deleteByIds fails, and a later drain removes the vector', async () => {
    const a = await readyAsset();
    const hub = fakeHub();
    const [gone] = await storeFaces(hub.env, a, result([face([100, 100, 300, 300], 9)]));
    const failingIndex = { upsert: async () => {}, deleteByIds: async () => { throw new Error('vectorize down'); } };
    const broken = { ...hub.env, TEST_FAKE_VECTORS: 'false', FACE_INDEX: failingIndex } as unknown as Env;
    await expect(storeFaces(broken, a, result([]))).rejects.toThrow('vectorize down');
    const queued = () => env.DB.prepare("SELECT COUNT(*) AS n FROM vector_delete_queue WHERE index_name = 'face' AND vector_id = ?1").bind(gone).first<number>('n');
    expect(await queued()).toBe(1);
    expect((await fakeVectorStore('face').query(embedding(9), { topK: 1, namespace: a.owner_id }))[0]?.id).toBe(gone);

    await drainVectorDeletes(hub.env, 'face');
    expect(await queued()).toBe(0);
    expect((await fakeVectorStore('face').query(embedding(9), { topK: 1, namespace: a.owner_id })).map((m) => m.id)).not.toContain(gone);
  });

  it('creates a fresh face when a vanished face is detected again', async () => {
    const a = await readyAsset();
    const hub = fakeHub();
    const [old] = await storeFaces(hub.env, a, result([face([100, 100, 300, 300])]));
    await storeFaces(hub.env, a, result([]));
    const [fresh] = await storeFaces(hub.env, a, result([face([100, 100, 300, 300])]));
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(old);
    expect((await facesOf(a.id)).map((r) => r.id)).toEqual([fresh]);
  });

  it('matches a face the user deleted instead of re-creating it', async () => {
    const a = await readyAsset();
    const hub = fakeHub();
    await insertFace(a, 'machine-learning', [50, 50, 150, 150], [720, 540], '2026-01-01T00:00:00.000Z');
    expect(await storeFaces(hub.env, a, result([face([100, 100, 300, 300])]))).toEqual([]);
    expect(await facesOf(a.id)).toHaveLength(1);
  });

  it('skips hidden assets (the video half of a live photo)', async () => {
    const a = await readyAsset();
    const hub = fakeHub();
    expect(await storeFaces(hub.env, { ...a, visibility: 'hidden' }, result([face([100, 100, 300, 300])]))).toEqual([]);
    expect(await facesOf(a.id)).toHaveLength(0);
  });

  it('leaves faces in place when the ML container is unavailable', async () => {
    const a = await readyAsset();
    const hub = fakeHub();
    await storeFaces(hub.env, a, result([face([100, 100, 300, 300])]));
    await env.MEDIA.put(thumbKey(a.id, 'preview'), new Uint8Array([0xff, 0xd8]));
    const down = { predict: async () => { throw new MlUnavailableError('cold'); }, embedText: async () => [] };
    await expect(processMl(hub.env, { assetId: a.id, force: true }, down)).rejects.toThrow('cold');
    const rows = await facesOf(a.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].deleted_at).toBeNull();
    expect(await embeddingOf(rows[0].id)).not.toBeNull();
  });
});
