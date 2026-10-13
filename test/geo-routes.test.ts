import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { processAsset } from '../src/process/consumer';
import type { Thumbnailer } from '../src/process/thumbs';
import { encode } from 'fast-png';
import { expectResponse } from './contract';
import { authHeaders, BASE, createUser, login, uploadAsset } from './helpers';
import { loadPlaces } from './geo-helpers';
import sampleJpg from './fixtures/media/sample.jpg?arraybuffer';

beforeEach(loadPlaces);

const png = encode({ width: 4, height: 3, data: new Uint8Array(4 * 3 * 4).fill(200), channels: 4 });
const thumbnailer: Thumbnailer = { render: async () => png, info: async () => ({ width: 4, height: 3 }) };

async function get(token: string, path: string) {
  const res = await SELF.fetch(`${BASE}/api${path}`, { headers: authHeaders(token) });
  return { status: res.status, body: (await res.json()) as any };
}

async function setup() {
  await createUser();
  return login();
}

describe('GET /map/reverse-geocode', () => {
  it('returns a one-element array with city, state and country', async () => {
    const token = await setup();
    const res = await get(token, '/map/reverse-geocode?lat=47.37&lon=8.55');
    expect(res.status).toBe(200);
    expectResponse('/map/reverse-geocode', 'get', 200, res.body);
    expect(res.body).toEqual([{ city: 'Zurich', state: 'Zurich', country: 'Switzerland' }]);
  });

  it('returns one all-null element in the open ocean', async () => {
    const token = await setup();
    const res = await get(token, '/map/reverse-geocode?lat=0&lon=-30');
    expectResponse('/map/reverse-geocode', 'get', 200, res.body);
    expect(res.body).toEqual([{ city: null, state: null, country: null }]);
  });

  it('rejects out-of-range and missing coordinates with 400', async () => {
    const token = await setup();
    expect((await get(token, '/map/reverse-geocode?lat=91&lon=0')).status).toBe(400);
    expect((await get(token, '/map/reverse-geocode?lat=0')).status).toBe(400);
  });
});

describe('GET /search/places', () => {
  it('matches name prefixes case-insensitively with admin names, name matches first', async () => {
    const token = await setup();
    const res = await get(token, '/search/places?name=zur');
    expect(res.status).toBe(200);
    expectResponse('/search/places', 'get', 200, res.body);
    expect(res.body.map((p: any) => p.name)).toEqual(['Zurich', 'Zurich', 'Winterthur']); // two name hits, then the state match
    expect(res.body[0]).toEqual({ name: 'Zurich', latitude: 47.3667, longitude: 8.55, admin1name: 'Zurich', admin2name: 'Bezirk Zurich' });
    expect(res.body[1].admin1name).toBe('Illinois');
  });

  it('also matches a state name', async () => {
    const token = await setup();
    const res = await get(token, '/search/places?name=tusc');
    expect(res.body.map((p: any) => p.name).sort()).toEqual(['Arezzo', 'Florence', 'Siena']);
  });

  it('treats LIKE wildcards as text and returns [] for no match', async () => {
    const token = await setup();
    expect((await get(token, '/search/places?name=%25')).body).toEqual([]);
    expect((await get(token, '/search/places?name=nowhereville')).body).toEqual([]);
  });

  it('requires name', async () => {
    const token = await setup();
    expect((await get(token, '/search/places')).status).toBe(400);
  });
});

describe('places from processed photos feed cities and suggestions', () => {
  it('lists the geocoded country, state and city', async () => {
    const token = await setup();
    const id = (await uploadAsset(token, new Uint8Array(sampleJpg))).body.id;
    await processAsset(env, id, thumbnailer);

    const country = await get(token, '/search/suggestions?type=country');
    expectResponse('/search/suggestions', 'get', 200, country.body);
    expect(country.body).toEqual(['Italy']);
    expect((await get(token, '/search/suggestions?type=state&country=Italy')).body).toEqual(['Tuscany']);
    expect((await get(token, '/search/suggestions?type=city&country=Italy&state=Tuscany')).body).toEqual(['Arezzo']);
    expect((await get(token, '/search/suggestions?type=state&country=France')).body).toEqual([]);

    const cities = await get(token, '/search/cities');
    expectResponse('/search/cities', 'get', 200, cities.body);
    expect(cities.body.map((a: any) => a.exifInfo.city)).toEqual(['Arezzo']);
  });
});
