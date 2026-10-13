import { env } from 'cloudflare:test';
import placesSql from './fixtures/geo/places.sql?raw';

/** Loads the small GeoNames fixture (one statement per line, `--` lines are comments). Call from beforeEach. */
export async function loadPlaces(): Promise<void> {
  const statements = placesSql
    .split('\n')
    .filter((l) => l.trim() !== '' && !l.startsWith('--'))
    .map((l) => env.DB.prepare(l));
  await env.DB.batch(statements);
}
