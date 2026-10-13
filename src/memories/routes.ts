import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { requireAuth } from '../auth/session';
import type { Dto } from '../gen/dto';
import { bad, boolQuery, intQuery, isoDate, isoDatetime, jsonObject, UUID_RE, uuidParam } from '../http/validate';
import {
  addMemoryAssets, assetsByMemory, createMemory, deleteMemory, existingMemoryAssetIds, mapMemory, ownedAssetIds, removeMemoryAssets,
  requireMemory, type MemoryRow,
} from './repo';
import { commit, tracked } from '../db/changes';

export const memoryRoutes = new Hono<AppEnv>();

const TYPES = ['on_this_day', 'birthday'];

interface SearchFilter {
  id?: string;
  type?: string;
  for?: string;
  isTrashed?: boolean;
  isSaved?: boolean;
  isUpcoming?: boolean;
  size?: number;
  page?: number;
  order?: string;
}

function parseSearch(q: Record<string, string>): SearchFilter {
  const f: SearchFilter = {
    isTrashed: boolQuery(q.isTrashed, 'isTrashed'),
    isSaved: boolQuery(q.isSaved, 'isSaved'),
    isUpcoming: boolQuery(q.isUpcoming, 'isUpcoming'),
    size: intQuery(q.size, 'size'),
    page: intQuery(q.page, 'page'),
  };
  if (q.id !== undefined) f.id = uuidParam(q.id);
  if (q.type !== undefined) f.type = TYPES.includes(q.type) ? q.type : bad('type must be one of: ' + TYPES.join(', '));
  if (q.for !== undefined) f.for = isoDate(q.for, 'for');
  if (q.order !== undefined) f.order = ['asc', 'desc', 'random'].includes(q.order) ? q.order : bad('order must be one of: asc, desc, random');
  return f;
}

function where(ownerId: string, f: SearchFilter, now: string) {
  const sql = ['owner_id = ?1', f.isTrashed ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL'];
  const binds: unknown[] = [ownerId];
  const bind = (v: unknown) => `?${binds.push(v)}`;
  if (f.isSaved !== undefined) sql.push(`is_saved = ${bind(f.isSaved ? 1 : 0)}`);
  if (f.type !== undefined) sql.push(`type = ${bind(f.type)}`);
  if (f.for !== undefined) {
    const p = bind(f.for);
    sql.push(`(show_at IS NULL OR show_at <= ${p})`, `(hide_at IS NULL OR hide_at >= ${p})`);
  }
  if (f.isUpcoming !== undefined) {
    const p = bind(now);
    sql.push(f.isUpcoming ? `show_at > ${p}` : `(show_at IS NULL OR show_at <= ${p})`);
  }
  if (f.id !== undefined) sql.push(`id = ${bind(f.id)}`);
  return { clause: sql.join(' AND '), binds };
}

memoryRoutes.get('/memories/statistics', requireAuth, async (c) => {
  const f = parseSearch(c.req.query());
  const { clause, binds } = where(c.get('auth').user.id, f, new Date().toISOString());
  const total = await c.env.DB.prepare(`SELECT count(*) AS n FROM memories WHERE ${clause}`).bind(...binds).first<number>('n');
  return c.json({ total: total ?? 0 });
});

memoryRoutes.get('/memories', requireAuth, async (c) => {
  const f = parseSearch(c.req.query());
  const { clause, binds } = where(c.get('auth').user.id, f, new Date().toISOString());
  const dir = f.order === 'asc' ? 'ASC' : 'DESC';
  const order = f.order === 'random' ? 'RANDOM()' : `show_at ${dir} NULLS LAST, memory_at ${dir}`;
  // Immich filters out memories without visible assets after paging, so page over the filtered rows too.
  const { results } = await c.env.DB.prepare(`SELECT * FROM memories WHERE ${clause} ORDER BY ${order}`).bind(...binds).all<MemoryRow>();
  const assets = await assetsByMemory(c.env.DB, results.map((m) => m.id));
  let list = results.map((m) => mapMemory(m, assets.get(m.id)!)).filter((m) => m.assets.length > 0);
  if (f.size !== undefined) {
    const offset = f.page !== undefined ? (f.page - 1) * f.size : 0;
    list = list.slice(offset, offset + f.size);
  }
  return c.json(list);
});

function parseData(raw: unknown, type: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return bad('data must be an object');
  const d = raw as Record<string, unknown>;
  if (!Number.isInteger(d.year) || (d.year as number) < 1000 || (d.year as number) > 9999) bad('data.year must be an integer between 1000 and 9999');
  const out: Record<string, unknown> = { year: d.year };
  if (d.personId !== undefined) {
    if (typeof d.personId !== 'string' || !UUID_RE.test(d.personId)) bad('data.personId must be a UUID');
    out.personId = d.personId;
  }
  if (d.personName !== undefined) {
    if (typeof d.personName !== 'string') bad('data.personName must be a string');
    out.personName = d.personName;
  }
  if (type === 'birthday') {
    for (const key of ['personId', 'personName']) if (out[key] === undefined) bad(`data.${key} is required for birthday memories`);
  }
  return out;
}

function idList(raw: unknown, what: string): string[] {
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string' || !UUID_RE.test(v))) return bad(`${what} must be an array of UUIDs`);
  return raw as string[];
}

memoryRoutes.post('/memories', requireAuth, async (c) => {
  const body = await jsonObject(c.req.raw);
  const user = c.get('auth').user;
  const type = typeof body.type === 'string' && TYPES.includes(body.type) ? body.type : bad('type must be one of: ' + TYPES.join(', '));
  const data = parseData(body.data, type);
  const memoryAt = isoDatetime(body.memoryAt, 'memoryAt');
  const assetIds = body.assetIds === undefined ? [] : idList(body.assetIds, 'assetIds');
  if (body.isSaved !== undefined && typeof body.isSaved !== 'boolean') bad('isSaved must be a boolean');
  const opt = (k: string) => (body[k] === undefined ? null : isoDatetime(body[k], k));
  const allowed = await ownedAssetIds(c.env.DB, user.id, assetIds);
  const id = await createMemory(
    c.env.DB,
    {
      ownerId: user.id, type: type as 'on_this_day' | 'birthday', data, isSaved: body.isSaved === true, memoryAt,
      seenAt: opt('seenAt'), showAt: opt('showAt'), hideAt: opt('hideAt'),
    },
    allowed,
  );
  if (id === null) return bad('An on this day memory for that date already exists');
  return c.json(await loadResponse(c.env.DB, id as string), 201);
});

async function loadResponse(db: D1Database, id: string): Promise<Dto<'MemoryResponseDto'>> {
  const m = (await db.prepare('SELECT * FROM memories WHERE id = ?1').bind(id).first<MemoryRow>())!;
  return mapMemory(m, (await assetsByMemory(db, [id])).get(id)!);
}

memoryRoutes.get('/memories/:id', requireAuth, async (c) => {
  const id = uuidParam(c.req.param('id'));
  await requireMemory(c.env.DB, id, c.get('auth').user.id, 'memory.read');
  return c.json(await loadResponse(c.env.DB, id));
});

memoryRoutes.put('/memories/:id', requireAuth, async (c) => {
  const id = uuidParam(c.req.param('id'));
  const body = await jsonObject(c.req.raw);
  await requireMemory(c.env.DB, id, c.get('auth').user.id, 'memory.update');
  const sets: string[] = [];
  const binds: unknown[] = [id];
  if (body.isSaved !== undefined) {
    if (typeof body.isSaved !== 'boolean') bad('isSaved must be a boolean');
    sets.push(`is_saved = ?${binds.push(body.isSaved ? 1 : 0)}`);
  }
  for (const [key, col] of [['seenAt', 'seen_at'], ['memoryAt', 'memory_at']] as const) {
    if (body[key] !== undefined) sets.push(`${col} = ?${binds.push(isoDatetime(body[key], key))}`);
  }
  if (sets.length === 0) bad('At least one field must be provided');
  sets.push(`updated_at = ?${binds.push(new Date().toISOString())}`);
  await commit(c.env.DB, [tracked(`UPDATE memories SET ${sets.join(', ')}, update_id = :cursor WHERE id = ?1`, ...binds)]);
  return c.json(await loadResponse(c.env.DB, id));
});

memoryRoutes.delete('/memories/:id', requireAuth, async (c) => {
  const id = uuidParam(c.req.param('id'));
  const m = await requireMemory(c.env.DB, id, c.get('auth').user.id, 'memory.delete');
  await deleteMemory(c.env.DB, m);
  return c.body(null, 204);
});

async function bulkIds(req: Request): Promise<string[]> {
  return idList((await jsonObject(req)).ids, 'ids');
}

memoryRoutes.put('/memories/:id/assets', requireAuth, async (c) => {
  const id = uuidParam(c.req.param('id'));
  const ids = await bulkIds(c.req.raw);
  const user = c.get('auth').user;
  await requireMemory(c.env.DB, id, user.id, 'memory.read');
  const present = await existingMemoryAssetIds(c.env.DB, id, ids);
  const allowed = await ownedAssetIds(c.env.DB, user.id, ids.filter((a) => !present.has(a)));
  const results: Dto<'BulkIdResponseDto'>[] = [];
  const added: string[] = [];
  for (const assetId of ids) {
    if (present.has(assetId)) results.push({ id: assetId, success: false, error: 'duplicate' });
    else if (!allowed.has(assetId)) results.push({ id: assetId, success: false, error: 'no_permission' });
    else {
      present.add(assetId);
      added.push(assetId);
      results.push({ id: assetId, success: true });
    }
  }
  await addMemoryAssets(c.env.DB, id, added);
  return c.json(results);
});

memoryRoutes.delete('/memories/:id/assets', requireAuth, async (c) => {
  const id = uuidParam(c.req.param('id'));
  const ids = await bulkIds(c.req.raw);
  const m = await requireMemory(c.env.DB, id, c.get('auth').user.id, 'memory.update');
  const present = await existingMemoryAssetIds(c.env.DB, id, ids);
  const results: Dto<'BulkIdResponseDto'>[] = [];
  const removed: string[] = [];
  for (const assetId of ids) {
    if (!present.has(assetId)) results.push({ id: assetId, success: false, error: 'not_found' });
    else {
      present.delete(assetId);
      removed.push(assetId);
      results.push({ id: assetId, success: true });
    }
  }
  await removeMemoryAssets(c.env.DB, m, removed);
  return c.json(results);
});
