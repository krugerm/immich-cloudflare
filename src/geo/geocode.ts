export interface Place {
  city: string | null;
  state: string | null;
  country: string | null;
}

export const NO_PLACE: Place = { city: null, state: null, country: null };

/** Immich reverseGeocodeMaxDistance. */
export const MAX_DISTANCE_KM = 25;
const KM_PER_DEGREE = 111.32;
const EARTH_RADIUS_KM = 6371;

const rad = (d: number) => (d * Math.PI) / 180;

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Longitude intervals (within -180..180) covering `km` around lon at this latitude. */
function lonRanges(lat: number, lon: number, km: number): Array<[number, number]> {
  const cos = Math.cos(rad(lat));
  const dlon = cos < 1e-6 ? 360 : km / (KM_PER_DEGREE * cos);
  if (dlon >= 180) return [[-180, 180]];
  const lo = lon - dlon;
  const hi = lon + dlon;
  if (lo < -180) return [[lo + 360, 180], [-180, hi]];
  if (hi > 180) return [[lo, 180], [-180, hi - 360]];
  return [[lo, hi]];
}

/** One index seek per cell on (cell, lon, lat); a BETWEEN on cell would scan every longitude in the band. */
export const candidateSql = (cellCount: number) =>
  `SELECT id, lat, lon FROM geo_place WHERE cell IN (${Array(cellCount).fill('?').join(',')}) AND lon BETWEEN ? AND ?`;

/**
 * Nearest GeoNames place within 25 km (Immich's rule): candidates come from the latitude cell and longitude index,
 * the winner from Haversine distance. Beyond 25 km all fields are null (no country-polygon fallback yet).
 */
export async function reverseGeocode(db: D1Database, lat: number, lon: number): Promise<Place> {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return NO_PLACE;
  const dlat = MAX_DISTANCE_KM / KM_PER_DEGREE;
  const loCell = Math.max(0, Math.floor((lat - dlat + 90) * 4));
  const hiCell = Math.min(720, Math.floor((lat + dlat + 90) * 4));
  const cells: number[] = [];
  for (let c = loCell; c <= hiCell; c++) cells.push(c);
  const ranges = await db.batch<{ id: number; lat: number; lon: number }>(
    lonRanges(lat, lon, MAX_DISTANCE_KM).map(([a, b]) => db.prepare(candidateSql(cells.length)).bind(...cells, a, b)),
  );
  let best: { id: number; km: number } | null = null;
  for (const r of ranges) {
    for (const p of r.results) {
      const km = haversineKm(lat, lon, p.lat, p.lon);
      if (km > MAX_DISTANCE_KM) continue;
      if (!best || km < best.km || (km === best.km && p.id < best.id)) best = { id: p.id, km };
    }
  }
  if (!best) return NO_PLACE;
  const row = await db
    .prepare('SELECT p.name, p.admin1, c.name AS country FROM geo_place p LEFT JOIN geo_country c ON c.code2 = p.cc WHERE p.id = ?1')
    .bind(best.id)
    .first<{ name: string; admin1: string | null; country: string | null }>();
  return row ? { city: row.name, state: row.admin1, country: row.country } : NO_PLACE;
}
