import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { candidateSql, reverseGeocode } from '../src/geo/geocode';
import { offsetMinutesAt, wallToUtc, zoneAt } from '../src/geo/timezone';
import { localDateTime } from '../src/process/exif';
import { loadPlaces } from './geo-helpers';

beforeEach(loadPlaces);

describe('reverseGeocode', () => {
  it('returns the nearest place within 25 km with state and country names', async () => {
    expect(await reverseGeocode(env.DB, 43.467448, 11.885127)).toEqual({ city: 'Arezzo', state: 'Tuscany', country: 'Italy' });
  });

  it('picks the nearest of several candidates, not the most populous', async () => {
    // Between Zurich (8.55) and Winterthur (8.7333), closer to Winterthur.
    expect(await reverseGeocode(env.DB, 47.49, 8.7)).toMatchObject({ city: 'Winterthur' });
    expect(await reverseGeocode(env.DB, 47.37, 8.56)).toMatchObject({ city: 'Zurich', country: 'Switzerland' });
  });

  it('returns nulls beyond 25 km and in the open ocean', async () => {
    expect(await reverseGeocode(env.DB, 0, -30)).toEqual({ city: null, state: null, country: null });
    // Arezzo is about 33 km from 43.46, 12.3 (0.42 deg of longitude).
    expect(await reverseGeocode(env.DB, 43.4633, 12.35)).toEqual({ city: null, state: null, country: null });
  });

  it('finds places across the antimeridian and at the date line', async () => {
    expect(await reverseGeocode(env.DB, -16.77, 179.99)).toMatchObject({ city: 'Somosomo', country: 'Fiji' });
    expect(await reverseGeocode(env.DB, -18.14, 178.44)).toMatchObject({ city: 'Suva' });
  });

  it('handles the poles and the southern hemisphere', async () => {
    expect(await reverseGeocode(env.DB, 90, 0)).toEqual({ city: null, state: null, country: null });
    expect(await reverseGeocode(env.DB, -90, 180)).toEqual({ city: null, state: null, country: null });
    expect(await reverseGeocode(env.DB, -33.87, 151.2)).toMatchObject({ city: 'Sydney', state: 'New South Wales' });
  });
});

describe('time zones under workerd', () => {
  it('@photostructure/tz-lookup resolves known coordinates', () => {
    expect(zoneAt(47.3667, 8.55)).toBe('Europe/Zurich');
    expect(zoneAt(40.7143, -74.006)).toBe('America/New_York');
    expect(zoneAt(35.6895, 139.6917)).toBe('Asia/Tokyo');
    expect(zoneAt(-33.8678, 151.2073)).toBe('Australia/Sydney');
    expect(zoneAt(27.7172, 85.324)).toBe('Asia/Kathmandu');
    expect(zoneAt(21.3069, -157.8583)).toBe('Pacific/Honolulu');
  });

  it('returns null for invalid coordinates instead of throwing', () => {
    expect(zoneAt(95, 0)).toBeNull();
    expect(zoneAt(Number.NaN, 0)).toBeNull();
  });

  it('computes zone offsets with Intl, including DST and half-hour zones', () => {
    expect(offsetMinutesAt('Europe/Zurich', Date.UTC(2024, 6, 1, 12))).toBe(120);
    expect(offsetMinutesAt('Europe/Zurich', Date.UTC(2024, 0, 1, 12))).toBe(60);
    expect(offsetMinutesAt('Asia/Kathmandu', Date.UTC(2024, 0, 1))).toBe(345);
    expect(offsetMinutesAt('America/New_York', Date.UTC(2024, 0, 1, 12))).toBe(-300);
    expect(offsetMinutesAt('Etc/UTC', Date.UTC(2024, 0, 1))).toBe(0);
  });

  it('converts wall-clock time to UTC, including across a DST change', () => {
    expect(new Date(wallToUtc(Date.UTC(2024, 4, 4, 10), 'Europe/Zurich')).toISOString()).toBe('2024-05-04T08:00:00.000Z');
    // 2024-03-31 01:30 is before the 02:00 spring-forward in Zurich (+1); 03:30 is after (+2).
    expect(new Date(wallToUtc(Date.UTC(2024, 2, 31, 1, 30), 'Europe/Zurich')).toISOString()).toBe('2024-03-31T00:30:00.000Z');
    expect(new Date(wallToUtc(Date.UTC(2024, 2, 31, 3, 30), 'Europe/Zurich')).toISOString()).toBe('2024-03-31T01:30:00.000Z');
  });

  it('localDateTime accepts an IANA zone and returns the original wall clock', () => {
    const wall = '2024-05-04T10:00:00.000Z';
    const utc = new Date(wallToUtc(Date.parse(wall), 'Europe/Zurich')).toISOString();
    expect(localDateTime(utc, 'Europe/Zurich', wall)).toBe(wall);
  });
});

describe('lookup query plan', () => {
  it('seeks the covering index on both cell and lon', async () => {
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${candidateSql(3)}`).bind(1, 2, 3, 8.0, 9.0).all<{ detail: string }>();
    const detail = results.map((r) => r.detail).join('\n');
    expect(detail).toMatch(/USING COVERING INDEX geo_place_cell_lon \(cell=\? AND lon>\? AND lon<\?\)/);
  });
});
