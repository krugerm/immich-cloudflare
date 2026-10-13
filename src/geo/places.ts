export interface PlaceMatch {
  name: string;
  latitude: number;
  longitude: number;
  admin1name?: string;
  admin2name?: string;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * GET /search/places: places whose name, state or county starts with the query (case-insensitive), at most 20.
 * Name matches come first. Immich also ranks by trigram similarity and searches alternate names; this is prefix only.
 */
export async function searchPlaces(db: D1Database, query: string): Promise<PlaceMatch[]> {
  const prefix = `${escapeLike(query.trim())}%`;
  const select = (col: string) =>
    db.prepare(`SELECT id, name, lat, lon, admin1, admin2 FROM geo_place WHERE ${col} LIKE ?1 ESCAPE '\\' ORDER BY name, id LIMIT 20`).bind(prefix);
  const [byName, byAdmin1, byAdmin2] = await db.batch<{ id: number; name: string; lat: number; lon: number; admin1: string | null; admin2: string | null }>([
    select('name'), select('admin1'), select('admin2'),
  ]);
  const seen = new Set<number>();
  const out: PlaceMatch[] = [];
  for (const r of [...byName.results, ...byAdmin1.results, ...byAdmin2.results]) {
    if (seen.has(r.id) || out.length >= 20) continue;
    seen.add(r.id);
    out.push({
      name: r.name,
      latitude: r.lat,
      longitude: r.lon,
      ...(r.admin1 ? { admin1name: r.admin1 } : {}),
      ...(r.admin2 ? { admin2name: r.admin2 } : {}),
    });
  }
  return out;
}
