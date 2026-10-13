import { getSystemConfig } from '../config/store';
import type { ExtractedExif } from '../process/exif';
import { NO_PLACE, reverseGeocode } from './geocode';
import { wallToUtc, zoneAt } from './timezone';

/**
 * Fills city, state and country from the coordinates (when reverse geocoding is enabled) and, when EXIF carries no
 * offset, the GPS time zone. A tag offset always wins, and so does a user-locked timeZone. `dateIsInstant` says
 * dateTimeOriginal is already a true UTC instant (videos); otherwise it is a wall-clock time marked UTC and moves to the
 * real instant in the GPS zone, which leaves local_date_time unchanged.
 * When geocoding is disabled the place fields stay undefined, which tells exifStatement to keep the stored place.
 */
export async function enrichGeo(env: Env, assetId: string, exif: ExtractedExif, opts: { dateIsInstant: boolean }): Promise<ExtractedExif> {
  const out: ExtractedExif = { ...exif };
  if ((await getSystemConfig(env.DB)).reverseGeocoding.enabled) {
    const place = exif.latitude === null || exif.longitude === null ? NO_PLACE : await reverseGeocode(env.DB, exif.latitude, exif.longitude);
    out.city = place.city;
    out.state = place.state;
    out.country = place.country;
  }
  const { latitude, longitude } = exif;
  if (latitude === null || longitude === null || exif.timeZone !== null) return out;
  const row = await env.DB.prepare('SELECT locked_properties FROM asset_exif WHERE asset_id = ?1').bind(assetId).first<{ locked_properties: string | null }>();
  if ((row?.locked_properties ?? '').includes('"timeZone"')) return out;
  const zone = zoneAt(latitude, longitude);
  if (zone) {
    out.timeZone = zone;
    if (exif.dateTimeOriginal && !opts.dateIsInstant) {
      out.dateTimeOriginal = new Date(wallToUtc(Date.parse(exif.dateTimeOriginal), zone)).toISOString();
    }
  }
  return out;
}
