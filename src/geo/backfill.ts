import { getSystemConfig } from '../config/store';
import { commit, tracked, type Tracked } from '../db/changes';
import { NO_PLACE, reverseGeocode } from './geocode';
import { offsetMinutesAt, wallToUtc, zoneAt } from './timezone';

interface Candidate {
  asset_id: string;
  type: string;
  latitude: number;
  longitude: number;
  date_time_original: string | null;
  time_zone: string | null;
  locked_properties: string | null;
  local_date_time: string;
}

const locked = (c: Candidate, property: string) => (c.locked_properties ?? '').includes(`"${property}"`);

/**
 * D1-only pass over assets that have GPS and no city: geocodes, fills a missing GPS time zone, and writes one tracked
 * `asset_exif` update per changed asset (plus a tracked `assets` update for a video whose local time moves). Reads no
 * originals. Pages by asset id: pass the returned `next` as `after` until it is null. Ocean points get a zone but stay
 * without a city, so callers must page rather than re-run from the start.
 */
export async function backfillPlaces(env: Env, limit: number, after = ''): Promise<{ processed: number; updated: number; next: string | null }> {
  const { results } = await env.DB.prepare(
    `SELECT e.asset_id, a.type, e.latitude, e.longitude, e.date_time_original, e.time_zone, e.locked_properties, a.local_date_time
     FROM asset_exif e JOIN assets a ON a.id = e.asset_id
     WHERE e.latitude IS NOT NULL AND e.longitude IS NOT NULL AND e.city IS NULL AND e.asset_id > ?1
     ORDER BY e.asset_id LIMIT ?2`,
  )
    .bind(after, limit)
    .all<Candidate>();
  if (results.length === 0) return { processed: 0, updated: 0, next: null };
  const geocode = (await getSystemConfig(env.DB)).reverseGeocoding.enabled;

  let updated = 0;
  let items: Tracked[] = [];
  const flush = async () => {
    if (items.length) await commit(env.DB, items);
    items = [];
  };
  for (const c of results) {
    const place = geocode ? await reverseGeocode(env.DB, c.latitude, c.longitude) : NO_PLACE;
    let timeZone = c.time_zone;
    let dateTimeOriginal = c.date_time_original;
    let localDate: string | null = null;
    if (timeZone === null && !locked(c, 'timeZone')) {
      const zone = zoneAt(c.latitude, c.longitude);
      if (zone) {
        timeZone = zone;
        if (dateTimeOriginal && !locked(c, 'dateTimeOriginal')) {
          const ms = Date.parse(dateTimeOriginal);
          if (c.type === 'VIDEO') {
            // A video's stored time is a true UTC instant; only its local wall clock changes.
            const local = new Date(ms + offsetMinutesAt(zone, ms) * 60_000).toISOString();
            if (local !== c.local_date_time) localDate = local;
          } else {
            dateTimeOriginal = new Date(wallToUtc(ms, zone)).toISOString(); // wall clock to the real instant; local time unchanged
          }
        }
      }
    }
    if (place.city === null && timeZone === c.time_zone) continue;
    items.push(
      tracked(
        `UPDATE asset_exif SET city = ?2, state = ?3, country = ?4, time_zone = ?5, date_time_original = ?6, update_id = :cursor WHERE asset_id = ?1`,
        c.asset_id, place.city, place.state, place.country, timeZone, dateTimeOriginal,
      ),
    );
    if (localDate) items.push(tracked(`UPDATE assets SET local_date_time = ?2, update_id = :cursor WHERE id = ?1`, c.asset_id, localDate));
    updated++;
    if (items.length >= 40) await flush();
  }
  await flush();
  return { processed: results.length, updated, next: results.length === limit ? results[results.length - 1].asset_id : null };
}
