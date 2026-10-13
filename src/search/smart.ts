// Phase 4 Task B: POST /search/smart. Text (or an asset's stored embedding) -> clip vector index (top 100, owner
// filter) -> D1 re-check with the metadata-search criteria -> Vectorize order, paged within the 100.
import type { Context } from 'hono';
import type { AppEnv } from '../app';
import { canReadAsset } from '../access/assets';
import { allowLocked, isUuid } from '../assets/access';
import { mapAssetResponse } from '../assets/map';
import { ImmichError } from '../http/errors';
import { fromBlob, MlUnavailableError, type MlClient } from '../ml/contract';
import { mlClient } from '../ml/client';
import { vectorStore } from '../ml/vectors';
import {
  ASSET_WITH_EXIF_SELECT, FLAT_FIELDS, FROM, filterCriteria, flatCriteria, readPage, readSize, splitRow, type Built,
} from './criteria';

type Obj = Record<string, unknown>;

/** Vectorize returns at most 100 matches per query. */
export const SMART_TOP_K = 100;
const CACHE_SIZE = 200;

let testClient: MlClient | undefined;
/** Test hook: replaces the container-backed client. Pass undefined to restore. */
export function setSmartSearchClient(client: MlClient | undefined): void {
  testClient = client;
  cache.clear();
}

// Per-isolate LRU of query embeddings (Map keeps insertion order).
const cache = new Map<string, number[]>();

async function embedQuery(ml: MlClient, query: string, language: string): Promise<number[]> {
  const key = `${language}\u0000${query}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const v = await ml.embedText(query);
  cache.set(key, v);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
  return v;
}

/** The caller plus the partners who share their timeline with the caller. */
async function partnerIds(db: D1Database, userId: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT p.shared_by_id AS id FROM partners p JOIN users u ON u.id = p.shared_by_id AND u.deleted_at IS NULL
       WHERE p.shared_with_id = ?1 AND p.in_timeline = 1`,
    )
    .bind(userId)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

/** Widens criteria's `a.owner_id = ?` to the caller plus partners; partner assets are never locked. */
function withPartners(built: Built, userId: string, partners: string[]): Built {
  if (partners.length === 0) return built;
  const where = [...built.where];
  where[0] = `(a.owner_id = ? OR (a.owner_id IN (${partners.map(() => '?').join(', ')}) AND a.visibility != 'locked'))`;
  return { where, binds: [userId, ...partners, ...built.binds.slice(1)] };
}

const emptyAlbums = { total: 0, count: 0, items: [], facets: [] };

export async function smartSearch(c: Context<AppEnv>, b: Obj) {
  const userId = c.get('auth').user.id;
  const elevated = allowLocked(c);
  const ml = testClient ?? mlClient(c.env);
  const store = vectorStore(c.env, 'clip');
  if (!ml || !store) throw new ImmichError(400, 'Smart search is not enabled');

  if (b.query !== undefined && typeof b.query !== 'string') throw new ImmichError(400, 'query must be a string');
  if (b.queryAssetId !== undefined && !isUuid(b.queryAssetId)) throw new ImmichError(400, 'queryAssetId must be a UUID');
  if (b.language !== undefined && typeof b.language !== 'string') throw new ImmichError(400, 'language must be a string');
  if (b.withExif !== undefined && typeof b.withExif !== 'boolean') throw new ImmichError(400, 'withExif must be a boolean');
  const withExif = b.withExif !== false;
  const size = readSize(b.size, 100);

  const structured = b.filter !== undefined || b.cursor !== undefined || b.orderBy !== undefined;
  let built: Built;
  let page = 1;
  if (structured) {
    const mixed = FLAT_FIELDS.filter((k) => b[k] !== undefined);
    if (mixed.length > 0) throw new ImmichError(400, `Deprecated search fields cannot be combined with filter, orderBy or cursor: ${mixed.join(', ')}`);
    built = filterCriteria(b.filter, userId, { elevated });
  } else {
    built = flatCriteria(b, userId, { elevated });
    page = readPage(b.page);
    // Hidden assets (live-photo videos) carry no embedding in Immich; keep them out when visibility is not chosen.
    if (b.visibility === undefined) built.where.push("a.visibility != 'hidden'");
  }

  const query = typeof b.query === 'string' ? b.query.trim() : '';
  let vector: number[];
  if (query) {
    try {
      vector = await embedQuery(ml, query, typeof b.language === 'string' ? b.language : '');
    } catch (err) {
      if (err instanceof MlUnavailableError) throw new ImmichError(503, 'Machine learning service is unavailable');
      throw err;
    }
  } else if (typeof b.queryAssetId === 'string') {
    if (!(await canReadAsset(c.env.DB, userId, b.queryAssetId, { elevated }))) throw new ImmichError(400, 'Not found or no asset.read access');
    const row = await c.env.DB.prepare('SELECT embedding FROM smart_search WHERE asset_id = ?1').bind(b.queryAssetId).first<{ embedding: ArrayBuffer }>();
    if (!row) throw new ImmichError(400, `Asset ${b.queryAssetId} has no embedding`);
    vector = fromBlob(row.embedding);
  } else {
    throw new ImmichError(400, 'Either query or queryAssetId must be set');
  }

  // Partners never contribute locked assets (Immich searches only the caller when visibility is locked).
  const partners = b.visibility === 'locked' ? [] : await partnerIds(c.env.DB, userId);
  built = withPartners(built, userId, partners);

  const owners = [userId, ...partners];
  const matches = await store.query(vector, { topK: SMART_TOP_K, filter: { ownerId: { $in: owners } } });
  const ranked = matches.map((m) => m.id);

  let rows = new Map<string, Record<string, any>>();
  if (ranked.length > 0) {
    const { results } = await c.env.DB.prepare(
      `SELECT ${ASSET_WITH_EXIF_SELECT} ${FROM} WHERE ${built.where.join(' AND ')} AND a.id IN (SELECT value FROM json_each(?))`,
    )
      .bind(...built.binds, JSON.stringify(ranked))
      .all<Record<string, any>>();
    rows = new Map(results.map((r) => [r.id as string, r]));
  }
  const ordered = ranked.filter((id) => rows.has(id));
  const start = (page - 1) * size;
  const slice = ordered.slice(start, start + size);
  const hasNext = ordered.length > start + size;
  const items = slice.map((id) => {
    const { asset, exif } = splitRow(rows.get(id)!);
    return mapAssetResponse(asset, withExif ? exif : null);
  });
  return {
    albums: emptyAlbums,
    assets: { total: items.length, count: items.length, items, facets: [], nextPage: !structured && hasNext ? String(page + 1) : null, nextCursor: null },
  };
}
