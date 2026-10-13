// stream G
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { expectResponse } from './contract';
import { authHeaders, BASE, createUser, login } from './helpers';

interface Seed {
  name: string;
  type?: string;
  date: string;
  fav?: number;
  vis?: string;
  deleted?: string | null;
  device?: string;
  size?: number;
  exif?: Partial<Record<string, string | number | null>>;
}

let counter = 0;
async function seed(ownerId: string, s: Seed): Promise<string> {
  const id = crypto.randomUUID();
  counter += 1;
  const uid = `00000000-0000-7000-8000-${String(counter).padStart(12, '0')}`;
  await env.DB.prepare(
    `INSERT INTO assets (id, owner_id, device_asset_id, device_id, type, original_path, original_file_name, checksum, file_created_at,
       file_modified_at, local_date_time, is_favorite, visibility, file_size, status, deleted_at, created_at, updated_at, update_id, width, height)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?3, ?7, ?8, ?8, ?8, ?9, ?10, 100, 'ready', ?11, ?8, ?8, ?12, 100, 100)`,
  )
    .bind(id, ownerId, s.name, s.device ?? 'dev1', s.type ?? 'IMAGE', `upload/${ownerId}/${id}.jpg`, `sum-${id}`, s.date, s.fav ?? 0, s.vis ?? 'timeline', s.deleted ?? null, uid)
    .run();
  if (s.exif) {
    const cols = Object.keys(s.exif);
    await env.DB.prepare(
      `INSERT INTO asset_exif (asset_id, owner_id, update_id, file_size_in_byte${cols.map((c) => `, ${c}`).join('')}) VALUES (?, ?, ?, ?${cols.map(() => ', ?').join('')})`,
    )
      .bind(id, ownerId, uid, s.size ?? 1000, ...cols.map((c) => s.exif![c]))
      .run();
  }
  return id;
}

async function post(token: string, path: string, body: unknown) {
  return SELF.fetch(`${BASE}/api${path}`, { method: 'POST', headers: { ...authHeaders(token), 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
async function get(token: string, path: string) {
  return SELF.fetch(`${BASE}/api${path}`, { headers: authHeaders(token) });
}

async function setup() {
  const user = await createUser();
  const token = await login();
  const other = await createUser({ email: 'o@example.com', isAdmin: false });
  const otherToken = await login('o@example.com');
  return { uid: user.id, token, oid: other.id, otherToken };
}

describe('POST /search/metadata (flat shape)', () => {
  it('filters, orders, pages and matches the contract', async () => {
    const { uid, token, oid } = await setup();
    const a = await seed(uid, { name: 'beach.jpg', date: '2024-01-01T00:00:00.000Z', exif: { make: 'Canon', model: 'R5', city: 'Zurich', country: 'Switzerland', rating: 4, description: 'Sunny Beach day' } });
    const b = await seed(uid, { name: 'city.jpg', date: '2024-02-01T00:00:00.000Z', fav: 1, exif: { make: 'Sony', model: 'A7', lens_model: '35mm', city: 'Bern', country: 'Switzerland' } });
    const c = await seed(uid, { name: 'clip.mp4', type: 'VIDEO', date: '2024-03-01T00:00:00.000Z', device: 'dev2' });
    await seed(oid, { name: 'theirs.jpg', date: '2024-04-01T00:00:00.000Z' });

    let res = await post(token, '/search/metadata', {});
    expect(res.status).toBe(200);
    let body = (await res.json()) as any;
    expectResponse('/search/metadata', 'post', 200, body);
    expect(body.assets.items.map((x: any) => x.id)).toEqual([c, b, a]); // newest first, owner only
    expect(body.assets.items[1].exifInfo.make).toBe('Sony');

    const q = async (filter: object) => ((await (await post(token, '/search/metadata', filter)).json()) as any).assets.items.map((x: any) => x.id);
    expect(await q({ order: 'asc' })).toEqual([a, b, c]);
    expect(await q({ type: 'VIDEO' })).toEqual([c]);
    expect(await q({ isFavorite: true })).toEqual([b]);
    expect(await q({ make: 'Canon' })).toEqual([a]);
    expect(await q({ model: 'A7', lensModel: '35mm' })).toEqual([b]);
    expect(await q({ country: 'Switzerland', city: 'Bern' })).toEqual([b]);
    expect(await q({ originalFileName: 'BEACH' })).toEqual([a]);
    expect(await q({ description: 'sunny' })).toEqual([a]);
    expect(await q({ rating: 4 })).toEqual([a]);
    expect(await q({ deviceId: 'dev2' })).toEqual([c]);
    expect(await q({ takenAfter: '2024-01-15T00:00:00.000Z', takenBefore: '2024-02-15T00:00:00.000Z' })).toEqual([b]);
    expect(await q({ city: null })).toEqual([]); // asset c has no exif row; a and b have cities
    expect(await q({ albumIds: [crypto.randomUUID()] })).toEqual([]);

    body = (await (await post(token, '/search/metadata', { size: 2 })).json()) as any;
    expect(body.assets.items).toHaveLength(2);
    expect(body.assets.nextPage).toBe('2');
    body = (await (await post(token, '/search/metadata', { size: 2, page: 2 })).json()) as any;
    expect(body.assets.items.map((x: any) => x.id)).toEqual([a]);
    expect(body.assets.nextPage).toBeNull();
    expectResponse('/search/metadata', 'post', 200, body);
  });

  it('hides trashed assets unless asked, and locked ones always', async () => {
    const { uid, token } = await setup();
    const live = await seed(uid, { name: 'live.jpg', date: '2024-01-01T00:00:00.000Z' });
    const trashed = await seed(uid, { name: 'gone.jpg', date: '2024-01-02T00:00:00.000Z', deleted: '2024-05-01T00:00:00.000Z' });
    await seed(uid, { name: 'secret.jpg', date: '2024-01-03T00:00:00.000Z', vis: 'locked' });
    const ids = async (b: object) => ((await (await post(token, '/search/metadata', b)).json()) as any).assets.items.map((x: any) => x.id);
    expect(await ids({})).toEqual([live]);
    expect(await ids({ withDeleted: true })).toEqual([trashed, live]);
    expect(await ids({ trashedAfter: '2024-01-01T00:00:00.000Z' })).toEqual([trashed]);
    expect((await post(token, '/search/metadata', { visibility: 'locked' })).status).toBe(401);
  });

  it('omits exifInfo when withExif is false', async () => {
    const { uid, token } = await setup();
    await seed(uid, { name: 'a.jpg', date: '2024-01-01T00:00:00.000Z', exif: { make: 'Canon' } });
    const body = (await (await post(token, '/search/metadata', { withExif: false })).json()) as any;
    expect(body.assets.items[0].exifInfo).toBeUndefined();
  });

  it('rejects bad input with 400 and unauthenticated calls with 401', async () => {
    const { token } = await setup();
    for (const bad of [{ size: 0 }, { size: 'x' }, { type: 'PHOTO' }, { takenAfter: 'yesterday' }, { rating: 9 }, { albumIds: ['nope'] }, { visibility: 'x' }, { order: 'up' }, { isFavorite: 'maybe' }]) {
      expect((await post(token, '/search/metadata', bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await SELF.fetch(`${BASE}/api/search/metadata`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/api/search/metadata`, { method: 'POST', headers: { ...authHeaders(token), 'content-type': 'application/json' }, body: '[' })).status).toBe(400);
  });
});

describe('POST /search/metadata (structured shape)', () => {
  it('supports filters, or-branches, orderBy and cursor paging', async () => {
    const { uid, token } = await setup();
    const a = await seed(uid, { name: 'a.jpg', date: '2024-01-01T00:00:00.000Z', exif: { city: 'Zurich', rating: 5 }, size: 300 });
    const b = await seed(uid, { name: 'b.jpg', date: '2024-02-01T00:00:00.000Z', exif: { city: 'Bern', rating: 2 }, size: 100 });
    const c = await seed(uid, { name: 'c.png', date: '2024-03-01T00:00:00.000Z', exif: { city: 'Basel', rating: 3 }, size: 200 });
    const ids = async (b: object) => ((await (await post(token, '/search/metadata', b)).json()) as any).assets.items.map((x: any) => x.id);
    expect(await ids({ filter: { city: { eq: 'Bern' } } })).toEqual([b]);
    expect(await ids({ filter: { originalFileName: { endsWith: '.png' } } })).toEqual([c]);
    expect(await ids({ filter: { rating: { gte: 3 } } })).toEqual([c, a]);
    expect(await ids({ filter: { or: [{ city: { eq: 'Zurich' } }, { city: { eq: 'Basel' } }] } })).toEqual([c, a]);
    expect(await ids({ filter: { city: { in: ['Zurich', 'Bern'] }, takenAt: { lt: '2024-01-15T00:00:00.000Z' } } })).toEqual([a]);
    expect(await ids({ orderBy: { field: 'fileSizeInBytes', direction: 'asc' } })).toEqual([b, c, a]);
    expect(await ids({ filter: { albumIds: { any: [crypto.randomUUID()] } } })).toEqual([]);

    const page1 = (await (await post(token, '/search/metadata', { size: 2, orderBy: { field: 'fileCreatedAt', direction: 'desc' } })).json()) as any;
    expectResponse('/search/metadata', 'post', 200, page1);
    expect(page1.assets.items.map((x: any) => x.id)).toEqual([c, b]);
    expect(page1.assets.nextCursor).toBeTruthy();
    expect(page1.assets.nextPage).toBeNull();
    const page2 = (await (await post(token, '/search/metadata', { size: 2, cursor: page1.assets.nextCursor })).json()) as any;
    expect(page2.assets.items.map((x: any) => x.id)).toEqual([a]);
    expect(page2.assets.nextCursor).toBeNull();
  });

  it('rejects mixing shapes, bad cursors and unknown fields', async () => {
    const { token } = await setup();
    expect((await post(token, '/search/metadata', { filter: {}, isFavorite: true })).status).toBe(400);
    expect((await post(token, '/search/metadata', { cursor: '!!!' })).status).toBe(400);
    expect((await post(token, '/search/metadata', { filter: { bogus: { eq: 1 } } })).status).toBe(400);
    expect((await post(token, '/search/metadata', { filter: { city: { wat: 'x' } } })).status).toBe(400);
    expect((await post(token, '/search/metadata', { filter: { visibility: { eq: 'locked' } } })).status).toBe(401);
  });
});

describe('filter hardening', () => {
  it('caps total bind values, rejects prototype keys and over-long LIKE patterns', async () => {
    const { token } = await setup();
    const vals = (n: number, p: string) => Array.from({ length: n }, (_, i) => `${p}${i}`);
    expect((await post(token, '/search/metadata', { filter: { city: { in: vals(60, 'a') }, state: { in: vals(60, 'b') } } })).status).toBe(400);
    expect((await post(token, '/search/metadata', { filter: { city: { in: vals(40, 'a') }, state: { in: vals(40, 'b') } } })).status).toBe(200);
    for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect((await post(token, '/search/metadata', { filter: JSON.parse(`{"${key}": {"eq": "x"}}`) })).status, key).toBe(400);
      expect((await post(token, '/search/metadata', { filter: JSON.parse(`{"city": {"${key}": "x"}}`) })).status, `op ${key}`).toBe(400);
    }
    const long = 'x'.repeat(60);
    expect((await post(token, '/search/metadata', { originalFileName: long })).status).toBe(400);
    expect((await post(token, '/search/metadata', { description: long })).status).toBe(400);
    expect((await post(token, '/search/metadata', { filter: { originalFileName: { like: long } } })).status).toBe(400);
    expect((await post(token, '/search/metadata', { filter: { originalFileName: { like: 'x'.repeat(40) } } })).status).toBe(200);
    expect((await post(token, '/search/large-assets?withExif=maybe', {})).status).toBe(400);
    expect((await post(token, '/search/large-assets?withExif=false', {})).status).toBe(200);
  });
});

describe('statistics, random and large assets', () => {
  it('counts, samples and ranks by size, owner-scoped', async () => {
    const { uid, token, oid } = await setup();
    await seed(uid, { name: 'a.jpg', date: '2024-01-01T00:00:00.000Z', fav: 1, exif: { make: 'Canon' }, size: 50 });
    const big = await seed(uid, { name: 'b.jpg', date: '2024-01-02T00:00:00.000Z', exif: { make: 'Canon' }, size: 5000 });
    await seed(uid, { name: 'c.jpg', date: '2024-01-03T00:00:00.000Z', vis: 'hidden', exif: { make: 'Canon' }, size: 9000 });
    await seed(oid, { name: 'd.jpg', date: '2024-01-04T00:00:00.000Z', exif: { make: 'Canon' }, size: 99999 });

    let res = await post(token, '/search/statistics', { make: 'Canon' });
    expect(res.status).toBe(200);
    let body = (await res.json()) as any;
    expectResponse('/search/statistics', 'post', 200, body);
    expect(body.total).toBe(3);
    expect(((await (await post(token, '/search/statistics', { isFavorite: true })).json()) as any).total).toBe(1);
    expect(((await (await post(token, '/search/statistics', { filter: { make: { eq: 'Canon' } } })).json()) as any).total).toBe(3);

    res = await post(token, '/search/random', { size: 2 });
    body = (await res.json()) as any;
    expectResponse('/search/random', 'post', 200, body);
    expect(body).toHaveLength(2);
    expect((await post(token, '/search/random', { size: 5000 })).status).toBe(400);

    res = await post(token, '/search/large-assets?minFileSize=1000', {});
    body = (await res.json()) as any;
    expectResponse('/search/large-assets', 'post', 200, body);
    expect(body.map((x: any) => x.id)).toEqual([big]); // hidden and other users' assets excluded
  });
});

describe('suggestions, cities, explore', () => {
  it('suggests distinct values with narrowing and includeNull', async () => {
    const { uid, token, oid } = await setup();
    await seed(uid, { name: 'a', date: '2024-01-01T00:00:00.000Z', exif: { make: 'Canon', model: 'R5', country: 'Switzerland', state: 'ZH', city: 'Zurich' } });
    await seed(uid, { name: 'b', date: '2024-01-02T00:00:00.000Z', exif: { make: 'Sony', model: 'A7', country: 'France', state: 'IDF', city: 'Paris' } });
    await seed(uid, { name: 'c', date: '2024-01-03T00:00:00.000Z', exif: { make: 'Canon', model: 'R6', country: 'Switzerland', state: 'BE', city: 'Bern' } });
    await seed(oid, { name: 'd', date: '2024-01-04T00:00:00.000Z', exif: { make: 'Nikon', country: 'Spain' } });
    const sug = async (qs: string) => {
      const res = await get(token, `/search/suggestions?${qs}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as unknown[];
      if (!qs.includes('includeNull')) expectResponse('/search/suggestions', 'get', 200, body); // Immich appends null despite the contract
      return body;
    };
    expect(await sug('type=camera-make')).toEqual(['Canon', 'Sony']);
    expect(await sug('type=camera-model&make=Canon')).toEqual(['R5', 'R6']);
    expect(await sug('type=country')).toEqual(['France', 'Switzerland']);
    expect(await sug('type=state&country=Switzerland')).toEqual(['BE', 'ZH']);
    expect(await sug('type=city&country=Switzerland&state=BE')).toEqual(['Bern']);
    expect(await sug('type=camera-make&includeNull=true')).toEqual(['Canon', 'Sony', null]);
    expect(await sug('type=camera-lens-model')).toEqual([]);
    expect((await get(token, '/search/suggestions')).status).toBe(400);
    expect((await get(token, '/search/suggestions?type=bogus')).status).toBe(400);
  });

  it('lists one asset per city and explores cities with at least five assets', async () => {
    const { uid, token } = await setup();
    for (let i = 0; i < 5; i++) await seed(uid, { name: `z${i}`, date: `2024-01-0${i + 1}T00:00:00.000Z`, exif: { city: 'Zurich' } });
    await seed(uid, { name: 'b', date: '2024-02-01T00:00:00.000Z', exif: { city: 'Bern' } });
    await seed(uid, { name: 'v', date: '2024-02-02T00:00:00.000Z', type: 'VIDEO', exif: { city: 'Basel' } });

    let res = await get(token, '/search/cities');
    let body = (await res.json()) as any[];
    expectResponse('/search/cities', 'get', 200, body);
    expect(body.map((x) => x.exifInfo.city)).toEqual(['Bern', 'Zurich']);

    res = await get(token, '/search/explore');
    body = (await res.json()) as any[];
    expectResponse('/search/explore', 'get', 200, body);
    expect(body[0].fieldName).toBe('exifInfo.city');
    expect(body[0].items.map((i: any) => i.value)).toEqual(['Zurich']);
    expect(body[1].fieldName).toBe('createdAt');
    expect(body[1].items.length).toBe(6);
  });

  it('answers smart search as disabled without ML, and person and places search with empty results', async () => {
    const { token } = await setup();
    let res = await post(token, '/search/smart', { query: 'dog' });
    expect(res.status).toBe(503); // the ML container is bound in tests but never starts: unavailable (see smart-search.test.ts)
    res = await get(token, '/search/person?name=bob');
    expect(await res.json()).toEqual([]);
    res = await get(token, '/search/places?name=zurich');
    expect(await res.json()).toEqual([]);
    expect((await get(token, '/search/places')).status).toBe(400);
  });
});

describe('map', () => {
  it('returns own markers with filters and rejects bad input', async () => {
    const { uid, token, oid, otherToken } = await setup();
    const a = await seed(uid, { name: 'a', date: '2024-01-01T00:00:00.000Z', fav: 1, exif: { latitude: 47.37, longitude: 8.54, city: 'Zurich', state: 'ZH', country: 'Switzerland' } });
    const b = await seed(uid, { name: 'b', date: '2024-02-01T00:00:00.000Z', exif: { latitude: 46.95, longitude: 7.44 } });
    const arch = await seed(uid, { name: 'arch', date: '2024-03-01T00:00:00.000Z', vis: 'archive', exif: { latitude: 1, longitude: 2 } });
    await seed(uid, { name: 'nogps', date: '2024-04-01T00:00:00.000Z', exif: { city: 'X' } });
    await seed(uid, { name: 'trash', date: '2024-05-01T00:00:00.000Z', deleted: '2024-06-01T00:00:00.000Z', exif: { latitude: 3, longitude: 4 } });
    await seed(oid, { name: 'theirs', date: '2024-06-01T00:00:00.000Z', exif: { latitude: 5, longitude: 6 } });
    const markers = async (qs = '', t = token) => {
      const res = await get(t, `/map/markers${qs}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as any[];
      expectResponse('/map/markers', 'get', 200, body);
      return body;
    };
    let body = await markers();
    expect(body.map((m) => m.id)).toEqual([b, a]);
    expect(body[1]).toEqual({ id: a, lat: 47.37, lon: 8.54, city: 'Zurich', state: 'ZH', country: 'Switzerland' });
    expect((await markers('?isFavorite=true')).map((m) => m.id)).toEqual([a]);
    expect((await markers('?isArchived=true')).map((m) => m.id)).toEqual([arch, b, a]);
    expect((await markers('?fileCreatedAfter=2024-01-15T00:00:00.000Z')).map((m) => m.id)).toEqual([b]);
    expect((await markers('', otherToken)).length).toBe(1);
    expect((await get(token, '/map/markers?isFavorite=maybe')).status).toBe(400);
    expect((await get(token, '/map/markers?fileCreatedAfter=nope')).status).toBe(400);
    expect((await SELF.fetch(`${BASE}/api/map/markers`)).status).toBe(401);
  });

  it('reverse-geocode validates input and returns an empty list', async () => {
    const { token } = await setup();
    const res = await get(token, '/map/reverse-geocode?lat=47.3&lon=8.5');
    expect(res.status).toBe(200);
    expectResponse('/map/reverse-geocode', 'get', 200, await res.json());
    expect((await get(token, '/map/reverse-geocode?lat=47.3')).status).toBe(400);
    expect((await get(token, '/map/reverse-geocode?lat=95&lon=8')).status).toBe(400);
  });
});

describe('server features', () => {
  it('advertises search, map and smart search', async () => {
    const f = (await (await SELF.fetch(`${BASE}/api/server/features`)).json()) as Record<string, boolean>;
    expect(f.search).toBe(true);
    expect(f.map).toBe(true);
    expect(f.smartSearch).toBe(true); // phase 4: the ML bindings are present
  });
});
