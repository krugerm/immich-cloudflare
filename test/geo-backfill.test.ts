import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { backfillPlaces } from '../src/geo/backfill';
import { updateSystemConfig, DEFAULTS } from '../src/config/store';
import { createUser } from './helpers';
import { loadPlaces } from './geo-helpers';

beforeEach(loadPlaces);

interface Seed {
  lat?: number | null;
  lon?: number | null;
  type?: 'IMAGE' | 'VIDEO';
  dto?: string;
  tz?: string | null;
  city?: string | null;
  locked?: string[];
}

let n = 0;
async function seed(ownerId: string, s: Seed = {}): Promise<string> {
  const id = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const dto = s.dto ?? '2024-05-04T10:00:00.000Z';
  await env.DB.prepare(
    `INSERT INTO assets (id, owner_id, device_asset_id, device_id, type, original_path, original_file_name, checksum, file_created_at,
       file_modified_at, local_date_time, is_favorite, visibility, file_size, status, created_at, updated_at, update_id)
     VALUES (?1, ?2, ?1, 'd', ?3, ?1, ?1, ?1, ?4, ?4, ?4, 0, 'timeline', 100, 'ready', ?4, ?4, '00000000-0000-7000-8000-000000000001')`,
  )
    .bind(id, ownerId, s.type ?? 'IMAGE', dto)
    .run();
  await env.DB.prepare(
    `INSERT INTO asset_exif (asset_id, owner_id, latitude, longitude, date_time_original, time_zone, city, locked_properties, update_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, '00000000-0000-7000-8000-000000000001')`,
  )
    .bind(id, ownerId, s.lat === undefined ? 47.3667 : s.lat, s.lon === undefined ? 8.55 : s.lon, dto, s.tz ?? null, s.city ?? null, s.locked ? JSON.stringify(s.locked) : null)
    .run();
  return id;
}
const exif = (id: string) => env.DB.prepare('SELECT * FROM asset_exif WHERE asset_id = ?1').bind(id).first<any>();
const asset = (id: string) => env.DB.prepare('SELECT * FROM assets WHERE id = ?1').bind(id).first<any>();

describe('backfillPlaces', () => {
  it('fills place and zone for photos with GPS and no city, as tracked exif updates', async () => {
    const u = await createUser();
    const id = await seed(u.id);
    const before = (await exif(id)).update_id;
    const r = await backfillPlaces(env, 100);
    expect(r).toMatchObject({ processed: 1, updated: 1, next: null });
    const e = await exif(id);
    expect(e).toMatchObject({ city: 'Zurich', state: 'Zurich', country: 'Switzerland', time_zone: 'Europe/Zurich', date_time_original: '2024-05-04T08:00:00.000Z' });
    expect(e.update_id > before).toBe(true);
    // A photo's local time is the wall clock, unchanged; the assets row is not touched.
    expect((await asset(id)).local_date_time).toBe('2024-05-04T10:00:00.000Z');
    expect((await asset(id)).update_id).toBe('00000000-0000-7000-8000-000000000001');
  });

  it('ignores assets without GPS or with a city, and a second run changes nothing', async () => {
    const u = await createUser();
    await seed(u.id, { lat: null, lon: null });
    await seed(u.id, { city: 'Already' });
    const id = await seed(u.id);
    expect((await backfillPlaces(env, 100)).processed).toBe(1);
    const after = (await exif(id)).update_id;
    expect((await backfillPlaces(env, 100)).processed).toBe(0);
    expect((await exif(id)).update_id).toBe(after);
  });

  it('keeps an existing offset zone and its date, and fills only the place', async () => {
    const u = await createUser();
    const id = await seed(u.id, { tz: 'UTC+2', dto: '2024-05-04T08:00:00.000Z' });
    await backfillPlaces(env, 100);
    expect(await exif(id)).toMatchObject({ city: 'Zurich', time_zone: 'UTC+2', date_time_original: '2024-05-04T08:00:00.000Z' });
  });

  it('respects a locked timeZone and a locked dateTimeOriginal', async () => {
    const u = await createUser();
    const a = await seed(u.id, { locked: ['timeZone'] });
    const b = await seed(u.id, { locked: ['dateTimeOriginal'] });
    await backfillPlaces(env, 100);
    expect(await exif(a)).toMatchObject({ city: 'Zurich', time_zone: null, date_time_original: '2024-05-04T10:00:00.000Z' });
    expect(await exif(b)).toMatchObject({ time_zone: 'Europe/Zurich', date_time_original: '2024-05-04T10:00:00.000Z' });
  });

  it('a video keeps its UTC instant and gets a shifted local_date_time through a tracked assets update', async () => {
    const u = await createUser();
    const id = await seed(u.id, { type: 'VIDEO', lat: 35.6895, lon: 139.6917, dto: '2024-05-04T01:00:00.000Z' });
    await backfillPlaces(env, 100);
    expect(await exif(id)).toMatchObject({ city: 'Tokyo', time_zone: 'Asia/Tokyo', date_time_original: '2024-05-04T01:00:00.000Z' });
    const a = await asset(id);
    expect(a.local_date_time).toBe('2024-05-04T10:00:00.000Z');
    expect(a.update_id > '00000000-0000-7000-8000-000000000001').toBe(true);
  });

  it('an ocean point gets a zone but no place, and is not picked again when paging past it', async () => {
    const u = await createUser();
    const ocean = await seed(u.id, { lat: 0, lon: -30 });
    const r = await backfillPlaces(env, 1);
    expect(r).toMatchObject({ processed: 1, next: ocean });
    expect(await exif(ocean)).toMatchObject({ city: null, country: null });
    expect((await exif(ocean)).time_zone).toBeTruthy();
    expect((await backfillPlaces(env, 1, r.next!)).processed).toBe(0);
  });

  it('pages with the returned cursor', async () => {
    const u = await createUser();
    const ids = [await seed(u.id), await seed(u.id), await seed(u.id)].sort();
    const p1 = await backfillPlaces(env, 2);
    expect(p1).toMatchObject({ processed: 2, next: ids[1] });
    const p2 = await backfillPlaces(env, 2, p1.next!);
    expect(p2).toMatchObject({ processed: 1, next: null });
    for (const id of ids) expect((await exif(id)).city).toBe('Zurich');
  });

  it('skips geocoding when reverseGeocoding is disabled but still fills the zone', async () => {
    await updateSystemConfig(env.DB, { ...DEFAULTS, reverseGeocoding: { enabled: false } });
    const u = await createUser();
    const id = await seed(u.id);
    await backfillPlaces(env, 100);
    expect(await exif(id)).toMatchObject({ city: null, time_zone: 'Europe/Zurich' });
  });
});
