import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { requestClustering } from '../src/faces/cluster';
import { clusterHubTestHooks } from '../src/faces/hub';
import { vectorSyncTestHooks } from '../src/people/repo';
import { vectorStore } from '../src/ml/vectors';
import { setPersonThumbnailRenderer } from '../src/people/thumbnail';
import { asset, base, call, clusterFaces, hub, near, personOf, recluster, seedFace, settle, user } from './people-helpers';

async function faces(token: string, ownerId: string, b: number[], count: number, seed: number, opts: { visibility?: string; indexed?: boolean } = {}) {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) ids.push(await seedFace(await asset(token, opts), ownerId, { embedding: near(b, seed + i), indexed: opts.indexed }));
  return ids;
}

afterEach(() => {
  setPersonThumbnailRenderer(undefined);
  vectorSyncTestHooks.beforeSync = undefined;
  clusterHubTestHooks.afterScanPage = undefined;
});

describe('ClusterHub', () => {
  it('groups two people, leaves noise unassigned and renders a thumbnail per new person', async () => {
    const rendered: string[] = [];
    setPersonThumbnailRenderer(async (_env, id) => {
      rendered.push(id);
    });
    const u = await user();
    const a = await faces(u.token, u.id, base(1), 4, 100);
    const b = await faces(u.token, u.id, base(2), 4, 200);
    const noise = [await seedFace(await asset(u.token), u.id, { embedding: base(3) }), await seedFace(await asset(u.token), u.id, { embedding: base(4) })];

    const status = await clusterFaces(u.id, [...a, ...b, ...noise]);
    expect(status).toMatchObject({ pending: 0, deferred: 0 });

    const ga = await personOf(a[0]);
    const gb = await personOf(b[0]);
    expect(ga).not.toBeNull();
    expect(gb).not.toBeNull();
    expect(ga).not.toBe(gb);
    for (const f of a) expect(await personOf(f)).toBe(ga);
    for (const f of b) expect(await personOf(f)).toBe(gb);
    for (const f of noise) expect(await personOf(f)).toBeNull();

    const { results: people } = await env.DB.prepare('SELECT * FROM people WHERE owner_id = ?1 ORDER BY person_group_id').bind(u.id).all<any>();
    expect(people.map((p) => p.person_group_id).sort()).toEqual([ga, gb].sort());
    for (const p of people) expect([...a, ...b]).toContain(p.face_id);
    expect(rendered.sort()).toEqual([ga, gb].sort());
    const groups = await env.DB.prepare('SELECT cluster_group_id FROM person_groups WHERE id = ?1').bind(ga).first<any>();
    expect(groups.cluster_group_id).toBe(u.id);
  });

  it('defers non-core faces: they join an existing person on the second pass and never found one', async () => {
    const u = await user();
    const bA = base(10);
    // queued first, but on an archived asset: not core, so it waits for person A
    const archived = await seedFace(await asset(u.token, { visibility: 'archive' }), u.id, { embedding: near(bA, 1) });
    const a = await faces(u.token, u.id, bA, 3, 20);
    const pair = await faces(u.token, u.id, base(11), 2, 30); // only two faces: below minFaces
    const single = await seedFace(await asset(u.token), u.id, { embedding: base(12) });

    await clusterFaces(u.id, [archived, ...pair, single, ...a]);
    const ga = await personOf(a[0]);
    expect(ga).not.toBeNull();
    expect(await personOf(archived)).toBe(ga);
    for (const f of pair) expect(await personOf(f)).toBeNull();
    expect(await personOf(single)).toBeNull();
    const n = await env.DB.prepare('SELECT count(*) AS n FROM people WHERE owner_id = ?1').bind(u.id).first<any>();
    expect(n.n).toBe(1);
  });

  it('finds neighbours Vectorize has not indexed yet through the hub buffer', async () => {
    const u = await user();
    const ids = await faces(u.token, u.id, base(40), 3, 41, { indexed: false });
    await clusterFaces(u.id, ids);
    const g = await personOf(ids[0]);
    expect(g).not.toBeNull();
    for (const f of ids) expect(await personOf(f)).toBe(g);
  });

  it('ignores trashed assets, soft-deleted faces and other cluster groups', async () => {
    const u = await user();
    const other = await user('other@example.com', false);
    const b = base(50);
    const mine = await faces(u.token, u.id, b, 2, 51);
    const trashed = await asset(u.token);
    const onTrash = await seedFace(trashed, u.id, { embedding: near(b, 60) });
    await env.DB.prepare('UPDATE assets SET deleted_at = ?1 WHERE id = ?2').bind(new Date().toISOString(), trashed).run();
    const soft = await seedFace(await asset(u.token), u.id, { embedding: near(b, 61) });
    await env.DB.prepare('UPDATE asset_faces SET deleted_at = ?1 WHERE id = ?2').bind(new Date().toISOString(), soft).run();
    // the same face embedding in another user's group never counts
    await faces(other.token, other.id, b, 3, 70);
    await clusterFaces(u.id, mine);
    for (const f of mine) expect(await personOf(f)).toBeNull();
  });

  it('keeps faces assigned by hand and renamed people through automatic passes; a forced pass resets only machine faces', async () => {
    const u = await user();
    const a = await faces(u.token, u.id, base(80), 4, 81);
    await clusterFaces(u.id, a);
    const ga = (await personOf(a[0]))!;
    expect((await call(u.token, 'PUT', `/people/${ga}`, { name: 'Alice' })).status).toBe(200);

    const bob = (await call(u.token, 'POST', '/people', { name: 'Bob' })).body.id;
    expect((await call(u.token, 'PUT', `/faces/${bob}`, { id: a[3] })).status).toBe(200);
    const manualAsset = await asset(u.token);
    expect(
      (await call(u.token, 'POST', '/faces', { personId: bob, assetId: manualAsset, imageWidth: 100, imageHeight: 100, x: 1, y: 2, width: 30, height: 40 })).status,
    ).toBe(201);

    // new face and an incremental pass: manual work survives
    const extra = await faces(u.token, u.id, base(80), 1, 90);
    await clusterFaces(u.id, extra);
    await recluster(u.id, false);
    expect(await personOf(a[3])).toBe(bob);
    expect((await call(u.token, 'GET', `/people/${ga}`)).body.name).toBe('Alice');
    expect(await personOf(extra[0])).not.toBeNull();

    // forced: every machine face is reset and re-clustered; the manual face keeps Bob
    await recluster(u.id, true);
    const manual = await env.DB.prepare("SELECT person_group_id FROM asset_faces WHERE source_type = 'manual'").first<any>();
    expect(manual.person_group_id).toBe(bob);
    expect((await call(u.token, 'GET', `/people/${bob}`)).body.name).toBe('Bob');
    expect(await personOf(a[3])).not.toBe(bob);
    const g = await personOf(a[0]);
    expect(g).not.toBeNull();
    for (const f of [...a, ...extra]) expect(await personOf(f)).toBe(g);
    // Alice's group lost all its faces in the reset, so Immich's cleanup removed her
    expect((await call(u.token, 'GET', `/people/${ga}`)).status).toBe(400);
    const audit = await env.DB.prepare('SELECT count(*) AS n FROM person_audit WHERE person_group_id = ?1').bind(ga).first<any>();
    expect(audit.n).toBe(1);
  });

  it('finds an assigned person even when the 100 nearest faces are all unassigned', async () => {
    const u = await user();
    const t = base(300);
    const a = await asset(u.token);
    const big = (await call(u.token, 'POST', '/people', { name: 'Big' })).body.id;
    for (let i = 0; i < 150; i++) await seedFace(a, u.id, { embedding: near(t, 1000 + i, 1.0), personGroupId: big, x1: i }); // cosine ~0.7
    for (let i = 0; i < 100; i++) await seedFace(a, u.id, { embedding: near(t, 2000 + i, 0.3), x1: 200 + i }); // cosine ~0.95, unassigned
    const probe = await seedFace(await asset(u.token), u.id, { embedding: near(t, 3000, 0.1) });
    await clusterFaces(u.id, [probe]);
    expect(await personOf(probe)).toBe(big);
  });

  it('flags assigned face vectors and clears the flag on unassignment', async () => {
    const u = await user();
    const ids = await faces(u.token, u.id, base(310), 3, 311);
    await clusterFaces(u.id, ids);
    const store = vectorStore(env, 'face')!;
    const flagged = async () => (await store.query(base(310), { topK: 10, namespace: u.id, filter: { assigned: '1' } })).map((m) => m.id).sort();
    expect(await flagged()).toEqual([...ids].sort());
    const g = (await personOf(ids[0]))!;
    expect((await call(u.token, 'DELETE', `/people/${g}`, {})).status).toBe(204);
    expect(await flagged()).toEqual([]);
  });

  it('resumes from the alarm when a hub restarts with queued work', async () => {
    const u = await user();
    const ids = await faces(u.token, u.id, base(325), 3, 326);
    // queue state as an evicted hub leaves it: faces in the queue, the resume alarm set, nothing running
    await runInDurableObject(hub(u.id), async (_h, state) => {
      for (const id of ids) state.storage.sql.exec('INSERT INTO queue (face_id) VALUES (?)', id);
      state.storage.sql.exec("INSERT INTO state (key, value) VALUES ('group', ?)", u.id);
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    await settle(u.id);
    for (const f of ids) expect(await personOf(f)).not.toBeNull();
    await runInDurableObject(hub(u.id), async (_h, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it('answers 202 at once and deletes its alarm when done', async () => {
    const u = await user();
    const ids = await faces(u.token, u.id, base(320), 3, 321);
    const res = await hub(u.id).fetch('https://cluster-hub/faces', { method: 'POST', body: JSON.stringify({ faceIds: ids }) });
    expect(res.status).toBe(202);
    expect(((await res.json()) as any).pending).toBe(3); // answered before the run (the alarm) started
    await settle(u.id);
    expect(await personOf(ids[0])).not.toBeNull();
    await runInDurableObject(hub(u.id), async (_h, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it('keeps errors from the caller, retries a failing face three times and goes on with the rest', async () => {
    const u = await user();
    const ids = await faces(u.token, u.id, base(330), 3, 331);
    const broken = await seedFace(await asset(u.token), u.id);
    await env.DB.prepare('INSERT INTO face_embeddings (face_id, embedding) VALUES (?1, ?2)').bind(broken, new Uint8Array([1, 2, 3])).run();
    const res = await hub(u.id).fetch('https://cluster-hub/faces', { method: 'POST', body: JSON.stringify({ faceIds: [broken, ...ids] }) });
    expect(res.status).toBe(202);
    await settle(u.id);
    expect(await personOf(broken)).toBeNull();
    for (const f of ids) expect(await personOf(f)).not.toBeNull();
  });

  it('repoints feature faces that were hard-deleted by re-detection', async () => {
    const rendered: string[] = [];
    setPersonThumbnailRenderer(async (_e, id) => {
      rendered.push(id);
    });
    const u = await user();
    const ids = await faces(u.token, u.id, base(340), 4, 341);
    await clusterFaces(u.id, ids);
    const g = (await personOf(ids[0]))!;
    const feature = (await env.DB.prepare('SELECT face_id FROM people WHERE person_group_id = ?1').bind(g).first<string>('face_id'))!;
    await env.DB.prepare('DELETE FROM asset_faces WHERE id = ?1').bind(feature).run(); // as Task D does for a vanished face
    rendered.length = 0;
    await requestClustering(env, u.id, { force: false });
    await settle(u.id);
    const now = await env.DB.prepare('SELECT face_id FROM people WHERE person_group_id = ?1').bind(g).first<string>('face_id');
    expect(now).not.toBe(feature);
    expect(ids.filter((f) => f !== feature)).toContain(now);
    expect(rendered).toEqual([g]);
  });

  it('requestClustering with force resets machine assignments once and re-clusters', async () => {
    const u = await user();
    const ids = await faces(u.token, u.id, base(350), 3, 351);
    await clusterFaces(u.id, ids);
    const before = await personOf(ids[0]);
    await requestClustering(env, u.id, { force: true });
    await settle(u.id);
    const after = await personOf(ids[0]);
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
    for (const f of ids) expect(await personOf(f)).toBe(after);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM people WHERE owner_id = ?1').bind(u.id).first('n')).toBe(1);
  });

  it('sets the assigned flag and requests the thumbnail on the next attempt when the vector write fails after the D1 commit', async () => {
    const rendered: string[] = [];
    setPersonThumbnailRenderer(async (_e, id) => {
      rendered.push(id);
    });
    let failures = 1;
    vectorSyncTestHooks.beforeSync = () => {
      if (failures-- > 0) throw new Error('vectorize down');
    };
    const u = await user();
    const ids = await faces(u.token, u.id, base(400), 3, 401);
    await clusterFaces(u.id, ids);
    const g = (await personOf(ids[0]))!;
    for (const f of ids) expect(await personOf(f)).toBe(g);
    const flagged = (await vectorStore(env, 'face')!.query(base(400), { topK: 10, namespace: u.id, filter: { assigned: '1' } })).map((m) => m.id).sort();
    expect(flagged).toEqual([...ids].sort());
    expect(rendered).toEqual([g]);
  });

  it('re-syncs flags of faces a forced reset unassigned when the vector write failed', async () => {
    const u = await user();
    const person = (await call(u.token, 'POST', '/people', {})).body.id;
    const a = await asset(u.token);
    // three unrelated faces under one person: after the reset nothing re-clusters them
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(await seedFace(a, u.id, { embedding: base(410 + i), personGroupId: person, x1: i * 100 }));
    let failures = 1;
    vectorSyncTestHooks.beforeSync = () => {
      if (failures-- > 0) throw new Error('vectorize down');
    };
    await recluster(u.id, true);
    for (const f of ids) expect(await personOf(f)).toBeNull();
    const store = vectorStore(env, 'face')!;
    for (let i = 0; i < 3; i++) {
      const flagged = await store.query(base(410 + i), { topK: 10, namespace: u.id, filter: { assigned: '1' } });
      expect(flagged).toEqual([]);
    }
  });

  it('a forced run arriving while a scan page is read restarts the scan and re-clusters every face', async () => {
    const u = await user();
    const ids = await faces(u.token, u.id, base(420), 3, 421);
    await clusterFaces(u.id, ids);
    const before = (await personOf(ids[0]))!;
    let fired = false;
    clusterHubTestHooks.afterScanPage = (h) => {
      if (fired) return;
      fired = true;
      h.startRun(u.id, true);
    };
    await recluster(u.id, false);
    expect(fired).toBe(true);
    const after = await personOf(ids[0]);
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
    for (const f of ids) expect(await personOf(f)).toBe(after);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM people WHERE owner_id = ?1').bind(u.id).first('n')).toBe(1);
  });

  it('does nothing while facial recognition is disabled', async () => {
    const u = await user();
    const res = await call(u.token, 'GET', '/system-config');
    const config = res.body;
    config.machineLearning.facialRecognition.enabled = false;
    expect((await call(u.token, 'PUT', '/system-config', config)).status).toBe(200);
    const a = await faces(u.token, u.id, base(95), 3, 96);
    expect(await clusterFaces(u.id, a)).toMatchObject({ pending: 0, deferred: 0 });
    for (const f of a) expect(await personOf(f)).toBeNull();
  });
});
