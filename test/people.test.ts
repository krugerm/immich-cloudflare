import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { vectorStore } from '../src/ml/vectors';
import { setPersonThumbnailRenderer } from '../src/people/thumbnail';
import { expectResponse } from './contract';
import { authHeaders, BASE } from './helpers';
import { asset, base, call, personOf, seedFace, seedPerson, user } from './people-helpers';

afterEach(() => setPersonThumbnailRenderer(undefined));

let seedCounter = 0;

/** A person of `owner` with `count` faces, each on its own asset. */
async function personWithFaces(u: { token: string; id: string }, count: number, body: Record<string, unknown> = {}) {
  const id = await seedPerson(u.token, body);
  const assets: string[] = [];
  const faces: string[] = [];
  for (let i = 0; i < count; i++) {
    const a = await asset(u.token);
    assets.push(a);
    faces.push(await seedFace(a, u.id, { personGroupId: id, embedding: base(1000 + seedCounter++) }));
  }
  await env.DB.prepare('UPDATE people SET face_id = ?1 WHERE person_group_id = ?2').bind(faces[0] ?? null, id).run();
  return { id, assets, faces };
}

describe('people', () => {
  it('lists people with Immich visibility, counts, order and paging', async () => {
    const u = await user();
    const big = await personWithFaces(u, 4);
    const named = await personWithFaces(u, 1, { name: 'Zoe' });
    await personWithFaces(u, 2); // unnamed with fewer than 3 faces: not listed
    const hidden = await personWithFaces(u, 3, { isHidden: true });
    const fav = await personWithFaces(u, 3, { isFavorite: true });

    const res = await call(u.token, 'GET', '/people');
    expect(res.status).toBe(200);
    expectResponse('/people', 'get', 200, res.body);
    expect(res.body.people.map((p: any) => p.id)).toEqual([fav.id, named.id, big.id]);
    expect(res.body).toMatchObject({ total: 4, hidden: 1, hasNextPage: false });

    const all = await call(u.token, 'GET', '/people?withHidden=true&size=2');
    expect(all.body.people.map((p: any) => p.id)).toEqual([fav.id, named.id]);
    expect(all.body.hasNextPage).toBe(true);
    const page2 = await call(u.token, 'GET', '/people?withHidden=true&size=2&page=2');
    expect(page2.body.people.map((p: any) => p.id)).toEqual([big.id, hidden.id]);
    expect(page2.body.hasNextPage).toBe(false);

    expect((await call(u.token, 'GET', '/people?isHidden=true')).body.people.map((p: any) => p.id)).toEqual([hidden.id]);
    expect((await call(u.token, 'GET', '/people?name=zo')).body.people.map((p: any) => p.id)).toEqual([named.id]);
    expect((await call(u.token, 'GET', '/people?size=0')).status).toBe(400);
    expect((await call(u.token, 'GET', '/people?withHidden=maybe')).status).toBe(400);

    // trashed assets and soft-deleted faces stop counting
    for (const a of big.assets.slice(0, 2)) await env.DB.prepare('UPDATE assets SET deleted_at = ?1 WHERE id = ?2').bind(new Date().toISOString(), a).run();
    expect((await call(u.token, 'GET', '/people')).body.people.map((p: any) => p.id)).not.toContain(big.id);
  });

  it('orders by closeness to a face or person', async () => {
    const u = await user();
    const p1 = await personWithFaces(u, 3);
    const p2 = await personWithFaces(u, 3);
    const probe = await seedFace(await asset(u.token), u.id, { embedding: (await embeddingOf(p2.faces[0])).map((v) => v + 0.01) });
    const res = await call(u.token, 'GET', `/people?closestAssetId=${probe}`);
    expect(res.body.people.map((p: any) => p.id)).toEqual([p2.id, p1.id]);
    const byPerson = await call(u.token, 'GET', `/people?closestPersonId=${p1.id}`);
    expect(byPerson.body.people[0].id).toBe(p1.id);
    const empty = await seedPerson(u.token);
    expect((await call(u.token, 'GET', `/people?closestPersonId=${empty}`)).status).toBe(404);
    // another user's face cannot be used as a similarity probe
    const other = await user('other@example.com', false);
    const foreign = await seedFace(await asset(other.token), other.id, { embedding: base(5000) });
    const refused = await call(u.token, 'GET', `/people?closestAssetId=${foreign}`);
    expect(refused.status).toBe(400);
    expect(refused.body.message).toBe('Not found or no face access');
    expect((await call(u.token, 'GET', `/people?closestAssetId=${crypto.randomUUID()}`)).status).toBe(400);
  });

  it('creates, reads and updates a person', async () => {
    const u = await user();
    const created = await call(u.token, 'POST', '/people', { name: 'Ann', birthDate: '1990-05-01', color: 'ff0000' });
    expect(created.status).toBe(201);
    expectResponse('/people', 'post', 201, created.body);
    expect(created.body).toMatchObject({ name: 'Ann', birthDate: '1990-05-01', color: '#ff0000', isHidden: false, isFavorite: false, otherPeople: [], sharedBy: [], sharedWith: [] });
    const id = created.body.id;
    const got = await call(u.token, 'GET', `/people/${id}`);
    expectResponse('/people/{id}', 'get', 200, got.body);

    const updated = await call(u.token, 'PUT', `/people/${id}`, { name: 'Anna', isHidden: true, birthDate: null });
    expect(updated.status).toBe(200);
    expectResponse('/people/{id}', 'put', 200, updated.body);
    expect(updated.body).toMatchObject({ name: 'Anna', isHidden: true, birthDate: null });
    expect(updated.body.updatedAt >= created.body.updatedAt).toBe(true);
    const row = await env.DB.prepare('SELECT update_id FROM people WHERE person_group_id = ?1').bind(id).first<any>();
    expect(row.update_id > '00000000-0000-7000-8000-000000000000').toBe(true);

    expect((await call(u.token, 'PUT', `/people/${id}`, {})).status).toBe(400);
    expect((await call(u.token, 'PUT', `/people/${id}`, { birthDate: '2999-01-01' })).status).toBe(400);
    expect((await call(u.token, 'POST', '/people', { birthDate: 'yesterday' })).status).toBe(400);
    expect((await call(u.token, 'POST', '/people', { birthDate: '1990-05-01Tnonsense' })).status).toBe(400);
    // the web app sends luxon toISO(); the date part is stored, as Postgres does for a `date` column
    const iso = await call(u.token, 'PUT', `/people/${id}`, { birthDate: '1980-05-12T00:00:00.000+03:00' });
    expect(iso.status).toBe(200);
    expect(iso.body.birthDate).toBe('1980-05-12');
    expect((await call(u.token, 'PUT', `/people/${id}`, { isHidden: false, userId: crypto.randomUUID() })).status).toBe(400);

    const bulk = await call(u.token, 'PUT', '/people', { people: [{ id, isFavorite: true }, { id: crypto.randomUUID(), name: 'x' }] });
    expectResponse('/people', 'put', 200, bulk.body);
    expect(bulk.body).toEqual([{ id, success: true }, expect.objectContaining({ success: false, error: 'unknown' })]);
  });

  it('sets the feature face from an asset and serves the thumbnail', async () => {
    const rendered: string[] = [];
    setPersonThumbnailRenderer(async (e, id) => {
      rendered.push(id);
      await e.MEDIA.put(`people/${id}.jpeg`, new Uint8Array([0xff, 0xd8, 0xff]));
    });
    const u = await user();
    const p = await personWithFaces(u, 2);
    expect((await SELF.fetch(`${BASE}/api/people/${p.id}/thumbnail`, { headers: authHeaders(u.token) })).status).toBe(404);
    const res = await call(u.token, 'PUT', `/people/${p.id}`, { featureFaceAssetId: p.assets[1] });
    expect(res.status).toBe(200);
    expect(rendered).toEqual([p.id]);
    const row = await env.DB.prepare('SELECT face_id FROM people WHERE person_group_id = ?1').bind(p.id).first<any>();
    expect(row.face_id).toBe(p.faces[1]);
    expect((await call(u.token, 'PUT', `/people/${p.id}`, { featureFaceAssetId: await asset(u.token) })).status).toBe(400);
    const thumb = await SELF.fetch(`${BASE}/api/people/${p.id}/thumbnail`, { headers: authHeaders(u.token) });
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get('content-type')).toBe('image/jpeg');
    expect(thumb.headers.get('cache-control')).toBe('private, no-cache, no-transform');
    expect(new Uint8Array(await thumb.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xd8, 0xff]));
  });

  it('counts statistics over visible faces on timeline assets', async () => {
    const u = await user();
    const p = await personWithFaces(u, 3);
    await seedFace(p.assets[0], u.id, { personGroupId: p.id, x1: 300 }); // a second face on the same asset
    const archived = await asset(u.token, { visibility: 'archive' });
    await seedFace(archived, u.id, { personGroupId: p.id });
    await env.DB.prepare('UPDATE asset_faces SET deleted_at = ?1 WHERE id = ?2').bind(new Date().toISOString(), p.faces[2]).run();
    const res = await call(u.token, 'GET', `/people/${p.id}/statistics`);
    expectResponse('/people/{id}/statistics', 'get', 200, res.body);
    expect(res.body).toEqual({ assets: 2 });
  });

  it('merges people: faces move, empty fields are copied, sources are deleted with audit rows', async () => {
    const u = await user();
    const other = await user('other@example.com', false);
    const target = await personWithFaces(u, 2);
    const source = await personWithFaces(u, 2, { name: 'Sam', birthDate: '2000-01-02' });
    const foreign = await personWithFaces(other, 1);
    const res = await call(u.token, 'POST', '/people/merge', { ids: [target.id, source.id, foreign.id] });
    expect(res.status).toBe(200);
    expectResponse('/people/merge', 'post', 200, res.body);
    expect(res.body).toEqual([
      { id: target.id, success: true },
      { id: source.id, success: true },
      { id: foreign.id, success: false, error: 'no_permission' },
    ]);
    for (const f of [...target.faces, ...source.faces]) expect(await personOf(f)).toBe(target.id);
    expect(await personOf(foreign.faces[0])).toBe(foreign.id);
    const t = (await call(u.token, 'GET', `/people/${target.id}`)).body;
    expect(t).toMatchObject({ name: 'Sam', birthDate: '2000-01-02' });
    expect((await call(u.token, 'GET', `/people/${source.id}`)).status).toBe(400);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM person_audit WHERE person_group_id = ?1').bind(source.id).first('n')).toBe(1);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM person_groups WHERE id = ?1').bind(source.id).first('n')).toBe(0);

    expect((await call(u.token, 'POST', '/people/merge', { ids: [target.id] })).status).toBe(400);
    expect((await call(u.token, 'POST', '/people/merge', { ids: [target.id, target.id] })).status).toBe(400);
    const again = await personWithFaces(u, 1);
    const legacy = await call(u.token, 'POST', `/people/${target.id}/merge`, { ids: [again.id] });
    expect(legacy.body).toEqual([{ id: target.id, success: true }, { id: again.id, success: true }]);
  });

  it('reassigns faces between people and re-picks feature faces', async () => {
    const u = await user();
    const from = await personWithFaces(u, 2);
    const to = await seedPerson(u.token);
    const res = await call(u.token, 'PUT', `/people/${to}/reassign`, { data: [{ personId: from.id, assetId: from.assets[0] }] });
    expect(res.status).toBe(200);
    expectResponse('/people/{id}/reassign', 'put', 200, res.body);
    expect(res.body.map((p: any) => p.id)).toEqual([to]);
    expect(await personOf(from.faces[0])).toBe(to);
    expect(await personOf(from.faces[1])).toBe(from.id);
    const rows = await env.DB.prepare('SELECT person_group_id, face_id FROM people WHERE owner_id = ?1').bind(u.id).all<any>();
    const byId = Object.fromEntries(rows.results.map((r) => [r.person_group_id, r.face_id]));
    expect(byId[to]).toBe(from.faces[0]);
    expect(byId[from.id]).toBe(from.faces[1]);
  });

  it('deletes people, unassigns their faces with sync cursors and removes empty groups', async () => {
    const u = await user();
    const p = await personWithFaces(u, 2);
    await env.MEDIA.put(`people/${p.id}.jpeg`, new Uint8Array([1]));
    const before = await env.DB.prepare('SELECT update_id FROM asset_faces WHERE id = ?1').bind(p.faces[0]).first<string>('update_id');
    const del = await SELF.fetch(`${BASE}/api/people/${p.id}`, { method: 'DELETE', headers: authHeaders(u.token) });
    expect(del.status).toBe(204);
    expect(await personOf(p.faces[0])).toBeNull();
    const after = await env.DB.prepare('SELECT update_id FROM asset_faces WHERE id = ?1').bind(p.faces[0]).first<string>('update_id');
    expect(after! > before!).toBe(true);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM person_groups WHERE id = ?1').bind(p.id).first('n')).toBe(0);
    expect(await env.MEDIA.head(`people/${p.id}.jpeg`)).toBeNull();
    const q = await personWithFaces(u, 1);
    expect((await call(u.token, 'DELETE', '/people', { ids: [q.id] })).status).toBe(204);
    expect((await call(u.token, 'GET', `/people/${q.id}`)).status).toBe(400);
  });

  it("refuses other users' people with 400", async () => {
    const u = await user();
    const other = await user('other@example.com', false);
    const p = await personWithFaces(u, 3);
    for (const [method, path, body] of [
      ['GET', `/people/${p.id}`, undefined],
      ['PUT', `/people/${p.id}`, { name: 'x' }],
      ['DELETE', `/people/${p.id}`, {}],
      ['GET', `/people/${p.id}/statistics`, undefined],
      ['GET', `/people/${p.id}/thumbnail`, undefined],
      ['PUT', `/people/${p.id}/reassign`, { data: [] }],
      ['DELETE', '/people', { ids: [p.id] }],
    ] as const) {
      expect((await call(other.token, method, path, body)).status, `${method} ${path}`).toBe(400);
    }
    expect((await call(other.token, 'GET', '/people')).body.people).toEqual([]);
    expect((await call(other.token, 'GET', `/timeline/buckets?personId=${p.id}`)).status).toBe(400);
    expect((await call(u.token, 'GET', `/people/${p.id}`)).body.name).toBe('');
  });
});

async function embeddingOf(faceId: string): Promise<number[]> {
  const { fromBlob } = await import('../src/ml/contract');
  const row = await env.DB.prepare('SELECT embedding FROM face_embeddings WHERE face_id = ?1').bind(faceId).first<any>();
  return fromBlob(new Uint8Array(row.embedding));
}

describe('faces', () => {
  it('lists the faces of an asset with the caller person', async () => {
    const u = await user();
    const p = await personWithFaces(u, 1, { name: 'Pia' });
    const a = p.assets[0];
    await seedFace(a, u.id, { x1: 5 }); // unassigned, left of the first
    const hiddenFace = await seedFace(a, u.id, { x1: 500 });
    await env.DB.prepare('UPDATE asset_faces SET is_visible = 0 WHERE id = ?1').bind(hiddenFace).run();
    const res = await call(u.token, 'GET', `/faces?id=${a}`);
    expect(res.status).toBe(200);
    expectResponse('/faces', 'get', 200, res.body);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].person).toBeNull();
    expect(res.body[1]).toMatchObject({ id: p.faces[0], imageWidth: 1000, imageHeight: 800, boundingBoxX1: 10, sourceType: 'machine-learning' });
    expect(res.body[1].person).toMatchObject({ id: p.id, name: 'Pia' });
    const other = await user('other@example.com', false);
    expect((await call(other.token, 'GET', `/faces?id=${a}`)).status).toBe(400);
    expect((await call(u.token, 'GET', '/faces')).status).toBe(400);
  });

  it('creates manual faces and picks a feature face for a person without one', async () => {
    const u = await user();
    const person = await seedPerson(u.token, { name: 'Max' });
    const a = await asset(u.token);
    const res = await call(u.token, 'POST', '/faces', { personId: person, assetId: a, imageWidth: 400, imageHeight: 300, x: 10, y: 20, width: 50, height: 60 });
    expect(res.status).toBe(201);
    const face = await env.DB.prepare('SELECT * FROM asset_faces WHERE asset_id = ?1').bind(a).first<any>();
    expect(face).toMatchObject({ person_group_id: person, source_type: 'manual', x1: 10, y1: 20, x2: 60, y2: 80, image_width: 400, cluster_group_id: u.id, owner_id: u.id });
    expect(await env.DB.prepare('SELECT face_id FROM people WHERE person_group_id = ?1').bind(person).first('face_id')).toBe(face.id);
    const other = await user('other@example.com', false);
    const body = { personId: person, assetId: a, imageWidth: 400, imageHeight: 300, x: 1, y: 1, width: 5, height: 5 };
    expect((await call(other.token, 'POST', '/faces', body)).status).toBe(400);
  });

  it('repoints the feature face when it is deleted', async () => {
    const rendered: string[] = [];
    setPersonThumbnailRenderer(async (_e, id) => {
      rendered.push(id);
    });
    const u = await user();
    const p = await personWithFaces(u, 3);
    expect((await call(u.token, 'DELETE', `/faces/${p.faces[0]}`, { force: true })).status).toBe(204);
    const first = await env.DB.prepare('SELECT face_id FROM people WHERE person_group_id = ?1').bind(p.id).first<string>('face_id');
    expect(p.faces.slice(1)).toContain(first);
    expect((await call(u.token, 'DELETE', `/faces/${first}`, { force: false })).status).toBe(204);
    const second = await env.DB.prepare('SELECT face_id FROM people WHERE person_group_id = ?1').bind(p.id).first<string>('face_id');
    expect(p.faces.slice(1).filter((f) => f !== first)).toContain(second);
    expect(rendered).toEqual([p.id, p.id]);
  });

  it('moves one face to a person', async () => {
    const u = await user();
    const from = await personWithFaces(u, 1);
    const to = await seedPerson(u.token, { name: 'To' });
    const res = await call(u.token, 'PUT', `/faces/${to}`, { id: from.faces[0] });
    expect(res.status).toBe(200);
    expectResponse('/faces/{id}', 'put', 200, res.body);
    expect(res.body).toMatchObject({ id: to, name: 'To' });
    expect(await personOf(from.faces[0])).toBe(to);
    const other = await user('other@example.com', false);
    const theirs = await seedPerson(other.token);
    expect((await call(other.token, 'PUT', `/faces/${theirs}`, { id: from.faces[0] })).status).toBe(400);
  });

  it('soft-deletes a face, or removes it with an audit row and its vector when forced', async () => {
    const u = await user();
    const a = await asset(u.token);
    const soft = await seedFace(a, u.id, { embedding: base(7) });
    const hard = await seedFace(a, u.id, { embedding: base(8), x1: 200 });
    expect((await call(u.token, 'DELETE', `/faces/${soft}`, { force: false })).status).toBe(204);
    expect(await env.DB.prepare('SELECT deleted_at FROM asset_faces WHERE id = ?1').bind(soft).first('deleted_at')).not.toBeNull();
    expect((await vectorStore(env, 'face')!.query(base(7), { topK: 10, namespace: u.id })).map((m) => m.id)).not.toContain(soft);
    expect((await call(u.token, 'DELETE', `/faces/${hard}`, { force: true })).status).toBe(204);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM asset_faces WHERE id = ?1').bind(hard).first('n')).toBe(0);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM face_embeddings WHERE face_id = ?1').bind(hard).first('n')).toBe(0);
    expect(await env.DB.prepare('SELECT asset_id FROM asset_face_audit WHERE face_id = ?1').bind(hard).first('asset_id')).toBe(a);
    const left = await vectorStore(env, 'face')!.query(base(8), { topK: 10, namespace: u.id });
    expect(left.map((m) => m.id)).not.toContain(hard);
    expect((await call(u.token, 'DELETE', `/faces/${soft}`, {})).status).toBe(400);
    const other = await user('other@example.com', false);
    expect((await call(other.token, 'DELETE', `/faces/${soft}`, { force: true })).status).toBe(400);
  });
});

describe('search and timeline by person', () => {
  it('finds people by name and assets by person', async () => {
    const u = await user();
    const ann = await personWithFaces(u, 2, { name: 'Ann Lee' });
    const bob = await personWithFaces(u, 1, { name: 'Bob' });
    await seedFace(ann.assets[0], u.id, { personGroupId: bob.id, x1: 400 }); // Ann and Bob together on one asset
    await call(u.token, 'PUT', `/people/${bob.id}`, { isHidden: true });

    const byName = await call(u.token, 'GET', '/search/person?name=lee');
    expect(byName.status).toBe(200);
    expectResponse('/search/person', 'get', 200, byName.body);
    expect(byName.body.map((p: any) => p.id)).toEqual([ann.id]);
    expect((await call(u.token, 'GET', '/search/person?name=bo')).body).toEqual([]);
    expect((await call(u.token, 'GET', '/search/person?name=bo&withHidden=true')).body.map((p: any) => p.id)).toEqual([bob.id]);
    expect((await call(u.token, 'GET', '/search/person')).status).toBe(400);

    const ids = async (body: unknown) => (await call(u.token, 'POST', '/search/metadata', body)).body.assets.items.map((a: any) => a.id).sort();
    expect(await ids({ personIds: [ann.id] })).toEqual([...ann.assets].sort());
    expect(await ids({ personIds: [ann.id, bob.id] })).toEqual([ann.assets[0]]);
    expect(await ids({ personIds: [bob.id] })).toEqual([ann.assets[0], bob.assets[0]].sort());
    const lonely = await asset(u.token);
    expect(await ids({ filter: { personIds: { any: [ann.id, bob.id] } } })).toEqual([...ann.assets, bob.assets[0]].sort());
    expect(await ids({ filter: { personIds: { all: [ann.id, bob.id] } } })).toEqual([ann.assets[0]]);
    expect(await ids({ filter: { personIds: { none: [ann.id] } } })).toEqual([bob.assets[0], lonely].sort());
    expect(await ids({ filter: { hasPeople: { eq: false } } })).toEqual([lonely]);
    expect(await ids({ filter: { hasPeople: { eq: true } } })).toEqual([...ann.assets, bob.assets[0]].sort());

    const buckets = await call(u.token, 'GET', `/timeline/buckets?personId=${ann.id}`);
    expect(buckets.status).toBe(200);
    expect(buckets.body.reduce((s: number, b: any) => s + b.count, 0)).toBe(2);
  });
});
