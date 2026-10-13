// stream G: metadata search. Smart search, people search and place search need phase 4 (ML/geo data) and return empty results.
//
// Scope difference from Immich (gate C5, not implemented): every search here covers only the caller's own assets.
// Immich search.service getUserIdsToSearch adds the caller's in-timeline partners (getMyPartnerIds, timelineEnabled)
// to metadata, statistics, random, large-assets, smart search, cities and suggestions (never for visibility=locked),
// and an `albumIds` filter (flat or structured) searches the assets of those albums of any owner after an AlbumRead
// check, which is also the only search a shared link may run. Here `albumIds`, `isNotInAlbum` and `hasAlbums` keep
// stream G's no-album behaviour (a non-empty albumIds matches nothing), and shared links get 401 from requireAuth.
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../app';
import { allowLocked } from '../assets/access';
import { mapAssetResponse } from '../assets/map';
import { requireAuth } from '../auth/session';
import { searchPlaces } from '../geo/places';
import { ImmichError } from '../http/errors';
import { boolQuery } from '../http/validate'; // phase 4 E
import { searchPeopleByName } from '../people/routes'; // phase 4 E
import {
  ASSET_WITH_EXIF_SELECT, FLAT_FIELDS, FROM, decodeCursor, encodeCursor, filterCriteria, flatCriteria, readInt, readOneOf, readPage,
  readSize, splitRow, structuredOrder,
  type Bind, type Built,
} from './criteria';
import { smartSearch } from './smart';

export const searchRoutes = new Hono<AppEnv>();

type Obj = Record<string, unknown>;

async function readBody(c: Context<AppEnv>): Promise<Obj> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ImmichError(400, 'Request body must be valid JSON');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new ImmichError(400, 'Request body must be an object');
  return body as Obj;
}

const isStructured = (b: Obj) => b.filter !== undefined || b.orderBy !== undefined || b.cursor !== undefined;

/** Builds criteria from either request shape; they are mutually exclusive as in Immich. */
function criteriaFor(b: Obj, c: Context<AppEnv>, allowStructured = true): { built: Built; structured: boolean } {
  const userId = c.get('auth').user.id;
  const elevated = allowLocked(c); // C3
  if (allowStructured && isStructured(b)) {
    const mixed = FLAT_FIELDS.filter((k) => b[k] !== undefined);
    if (mixed.length > 0) throw new ImmichError(400, `Deprecated search fields cannot be combined with filter, orderBy or cursor: ${mixed.join(', ')}`);
    return { built: filterCriteria(b.filter, userId, { elevated }), structured: true };
  }
  return { built: flatCriteria(b, userId, { elevated }), structured: false };
}

const sql = (b: Built) => b.where.join(' AND ');

function mapRows(results: Record<string, any>[], withExif: boolean) {
  return results.map((r) => {
    const { asset, exif } = splitRow(r);
    return mapAssetResponse(asset, withExif ? exif : null);
  });
}

function withExifFlag(b: Obj): boolean {
  if (b.withExif === undefined) return true;
  if (typeof b.withExif !== 'boolean') throw new ImmichError(400, 'withExif must be a boolean');
  return b.withExif;
}

searchRoutes.post('/search/metadata', requireAuth, async (c) => {
  const b = await readBody(c);
  const { built, structured } = criteriaFor(b, c);
  const size = readSize(b.size, 250);
  const withExif = withExifFlag(b);
  let orderSql: string;
  let offset: number;
  let page = 1;
  if (structured) {
    orderSql = structuredOrder(b.orderBy);
    offset = decodeCursor(b.cursor);
  } else {
    const dir = (b.order === undefined ? 'desc' : readOneOf(b.order, 'order', ['asc', 'desc'])).toUpperCase();
    orderSql = `a.file_created_at ${dir}, a.id ${dir}`;
    page = readPage(b.page);
    offset = (page - 1) * size;
  }
  const { results } = await c.env.DB.prepare(
    `SELECT ${ASSET_WITH_EXIF_SELECT} ${FROM} WHERE ${sql(built)} ORDER BY ${orderSql} LIMIT ? OFFSET ?`,
  )
    .bind(...built.binds, size + 1, offset)
    .all<Record<string, any>>();
  const hasNext = results.length > size;
  const items = mapRows(hasNext ? results.slice(0, size) : results, withExif);
  return c.json({
    albums: { total: 0, count: 0, items: [], facets: [] },
    assets: {
      total: items.length,
      count: items.length,
      items,
      facets: [],
      nextPage: structured || !hasNext ? null : String(page + 1),
      nextCursor: structured && hasNext ? encodeCursor(offset + size) : null,
    },
  });
});

searchRoutes.post('/search/statistics', requireAuth, async (c) => {
  const b = await readBody(c);
  const { built } = criteriaFor(b, c);
  const row = await c.env.DB.prepare(`SELECT count(*) AS total ${FROM} WHERE ${sql(built)}`)
    .bind(...built.binds)
    .first<{ total: number }>();
  return c.json({ total: row?.total ?? 0 });
});

searchRoutes.post('/search/random', requireAuth, async (c) => {
  const b = await readBody(c);
  const { built } = criteriaFor(b, c);
  const size = readSize(b.size, 250);
  const withExif = withExifFlag(b);
  const { results } = await c.env.DB.prepare(`SELECT ${ASSET_WITH_EXIF_SELECT} ${FROM} WHERE ${sql(built)} ORDER BY random() LIMIT ?`)
    .bind(...built.binds, size)
    .all<Record<string, any>>();
  return c.json(mapRows(results, withExif));
});

/** Deprecated: the filters arrive as query parameters (the OpenAPI contract declares them so). */
searchRoutes.post('/search/large-assets', requireAuth, async (c) => {
  const q: Obj = c.req.query();
  const built = flatCriteria(q, c.get('auth').user.id, { defaultHidden: true, elevated: allowLocked(c) });
  const size = readSize(q.size, 250);
  const minFileSize = q.minFileSize === undefined ? 0 : readInt(q.minFileSize, 'minFileSize', 0, Number.MAX_SAFE_INTEGER);
  if (q.withExif !== undefined && q.withExif !== 'true' && q.withExif !== 'false') throw new ImmichError(400, 'withExif must be a boolean');
  const withExif = q.withExif !== 'false';
  const { results } = await c.env.DB.prepare(
    `SELECT ${ASSET_WITH_EXIF_SELECT} FROM assets a JOIN asset_exif e ON e.asset_id = a.id
     WHERE ${sql(built)} AND e.file_size_in_byte > ? ORDER BY e.file_size_in_byte DESC, a.id DESC LIMIT ?`,
  )
    .bind(...built.binds, minFileSize, size)
    .all<Record<string, any>>();
  return c.json(mapRows(results, withExif));
});

const SUGGESTION_COLUMNS: Record<string, string> = {
  country: 'country', state: 'state', city: 'city', 'camera-make': 'make', 'camera-model': 'model', 'camera-lens-model': 'lens_model',
};
// Which query parameters narrow each suggestion type, as in Immich's repository.
const SUGGESTION_FILTERS: Record<string, [string, string][]> = {
  country: [], state: [['country', 'country']], city: [['country', 'country'], ['state', 'state']],
  'camera-make': [['model', 'model'], ['lensModel', 'lens_model']], 'camera-model': [['make', 'make'], ['lensModel', 'lens_model']],
  'camera-lens-model': [['make', 'make'], ['model', 'model']],
};

searchRoutes.get('/search/suggestions', requireAuth, async (c) => {
  const q = c.req.query();
  if (q.type === undefined) throw new ImmichError(400, 'type is required');
  const type = readOneOf(q.type, 'type', Object.keys(SUGGESTION_COLUMNS));
  const col = SUGGESTION_COLUMNS[type];
  let includeNull = false;
  if (q.includeNull !== undefined) {
    if (q.includeNull !== 'true' && q.includeNull !== 'false') throw new ImmichError(400, 'includeNull must be a boolean');
    includeNull = q.includeNull === 'true';
  }
  const where = ["a.owner_id = ?", "a.visibility = 'timeline'", 'a.deleted_at IS NULL', `e.${col} IS NOT NULL`, `e.${col} != ''`];
  const binds: Bind[] = [c.get('auth').user.id];
  for (const [param, column] of SUGGESTION_FILTERS[type]) {
    if (q[param]) {
      where.push(`e.${column} = ?`);
      binds.push(q[param]);
    }
  }
  const { results } = await c.env.DB.prepare(
    `SELECT DISTINCT e.${col} AS v FROM assets a JOIN asset_exif e ON e.asset_id = a.id WHERE ${where.join(' AND ')} ORDER BY v`,
  )
    .bind(...binds)
    .all<{ v: string }>();
  const out: (string | null)[] = results.map((r) => r.v);
  if (includeNull) out.push(null);
  return c.json(out);
});

/** One image per city (the lowest asset id), timeline-visible and not trashed. */
async function assetsByCity(db: D1Database, userId: string, minAssets: number, limit: number) {
  const { results } = await db
    .prepare(
      `SELECT ${ASSET_WITH_EXIF_SELECT} FROM assets a JOIN asset_exif e ON e.asset_id = a.id
       WHERE a.id IN (
         SELECT min(a2.id) FROM assets a2 JOIN asset_exif e2 ON e2.asset_id = a2.id
         WHERE a2.owner_id = ?1 AND a2.visibility = 'timeline' AND a2.type = 'IMAGE' AND a2.deleted_at IS NULL AND e2.city IS NOT NULL
         GROUP BY e2.city HAVING count(*) >= ?2)
       ORDER BY e.city LIMIT ?3`,
    )
    .bind(userId, minAssets, limit)
    .all<Record<string, any>>();
  return results;
}

searchRoutes.get('/search/cities', requireAuth, async (c) => {
  const results = await assetsByCity(c.env.DB, c.get('auth').user.id, 1, 1000);
  return c.json(mapRows(results, true));
});

searchRoutes.get('/search/explore', requireAuth, async (c) => {
  const userId = c.get('auth').user.id;
  const cities = await assetsByCity(c.env.DB, userId, 5, 12);
  const { results: recents } = await c.env.DB.prepare(
    `SELECT ${ASSET_WITH_EXIF_SELECT} ${FROM}
     WHERE a.owner_id = ? AND a.visibility = 'timeline' AND a.type = 'IMAGE' AND a.deleted_at IS NULL
     ORDER BY a.created_at DESC LIMIT 12`,
  )
    .bind(userId)
    .all<Record<string, any>>();
  const item = (r: Record<string, any>, value: string) => ({ value, data: mapAssetResponse(splitRow(r).asset, splitRow(r).exif) });
  return c.json([
    { fieldName: 'exifInfo.city', items: cities.map((r) => item(r, r.x_city)) },
    { fieldName: 'createdAt', items: recents.map((r) => item(r, r.created_at)) },
  ]);
});

// ---- deferred to phase 4 (ML / geocoding data); Immich-shaped empty results ------------------

searchRoutes.post('/search/smart', requireAuth, async (c) => c.json(await smartSearch(c, await readBody(c))));

// phase 4 E
searchRoutes.get('/search/person', requireAuth, async (c) => {
  const name = c.req.query('name');
  if (!name) throw new ImmichError(400, 'name is required');
  const withHidden = boolQuery(c.req.query('withHidden'), 'withHidden') ?? false;
  return c.json(await searchPeopleByName(c.env.DB, c.get('auth').user.id, name, withHidden));
});

searchRoutes.get('/search/places', requireAuth, async (c) => {
  const name = c.req.query('name');
  if (!name) throw new ImmichError(400, 'name is required');
  return c.json(await searchPlaces(c.env.DB, name));
});
