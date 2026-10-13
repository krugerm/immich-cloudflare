// stream G: request parsing and SQL building for the search endpoints.
import type { AssetRow, ExifRow } from '../db/rows';
import { ImmichError } from '../http/errors';

export type Bind = string | number | null;
type Obj = Record<string, unknown>;

const VISIBILITIES = ['archive', 'timeline', 'hidden', 'locked'];
const TYPES = ['IMAGE', 'VIDEO', 'AUDIO', 'OTHER'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const bad = (msg: string): never => {
  throw new ImmichError(400, msg);
};

/** Flat (deprecated) request fields that cannot be combined with the structured shape. */
export const FLAT_FIELDS = [
  'albumIds', 'checksum', 'city', 'country', 'createdAfter', 'createdBefore', 'description', 'encodedVideoPath', 'id',
  'isEncoded', 'isFavorite', 'isMotion', 'isNotInAlbum', 'isOffline', 'lensModel', 'libraryId', 'make', 'model', 'ocr',
  'order', 'originalFileName', 'originalPath', 'page', 'personIds', 'previewPath', 'rating', 'state', 'tagIds',
  'takenAfter', 'takenBefore', 'thumbnailPath', 'trashedAfter', 'trashedBefore', 'type', 'updatedAfter', 'updatedBefore',
  'visibility', 'withDeleted',
];

// ---- typed field readers -------------------------------------------------------------------

function iso(v: unknown, name: string): string {
  if (typeof v !== 'string') return bad(`${name} must be a date-time string`);
  const t = Date.parse(v);
  if (Number.isNaN(t)) return bad(`${name} must be a valid date-time`);
  return new Date(t).toISOString();
}

function str(v: unknown, name: string): string {
  return typeof v === 'string' ? v : bad(`${name} must be a string`);
}

function bool(v: unknown, name: string): boolean {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return bad(`${name} must be a boolean`);
}

function int(v: unknown, name: string, min: number, max: number): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) return bad(`${name} must be an integer between ${min} and ${max}`);
  return n;
}

function oneOf(v: unknown, name: string, allowed: string[]): string {
  return typeof v === 'string' && allowed.includes(v) ? v : bad(`${name} must be one of: ${allowed.join(', ')}`);
}

function uuidArray(v: unknown, name: string): string[] {
  const arr = typeof v === 'string' ? [v] : v;
  if (!Array.isArray(arr) || arr.some((x) => typeof x !== 'string' || !UUID.test(x))) return bad(`${name} must be an array of UUIDs`);
  return arr as string[];
}

const has = (o: Obj, k: string) => o[k] !== undefined;

// ---- LIKE helpers --------------------------------------------------------------------------

const escLike = (s: string) => s.replace(/[\\%_]/g, '\\$&');

/** D1 rejects LIKE/GLOB patterns longer than 50 bytes. */
const MAX_LIKE_BYTES = 50;
function likePattern(value: string, name: string, mode: 'contains' | 'starts' | 'ends' = 'contains'): string {
  const e = escLike(value);
  const p = mode === 'starts' ? `${e}%` : mode === 'ends' ? `%${e}` : `%${e}%`;
  if (new TextEncoder().encode(p).length > MAX_LIKE_BYTES) bad(`${name} is too long for text matching (at most ${MAX_LIKE_BYTES} bytes after escaping)`);
  return p;
}

/** D1 allows 100 bind parameters per statement; callers append up to two more (limit, offset). */
const MAX_FILTER_BINDS = 98;
function capBinds(b: Built): Built {
  if (b.binds.length > MAX_FILTER_BINDS) bad('Too many filter values');
  return b;
}

// ---- flat shape ----------------------------------------------------------------------------

export interface Built {
  where: string[];
  binds: Bind[];
}

export const NEVER = '0';

/** Parses the flat (deprecated) shape. `body` values may be strings (query) or JSON values. */
/**
 * `elevated` (C3): the session is PIN-elevated. Immich then admits visibility=locked and, without a visibility filter,
 * includes locked assets. Search is owner-only here, so locked results are always the caller's own.
 */
export function flatCriteria(body: Obj, userId: string, opts: { defaultHidden?: boolean; elevated?: boolean } = {}): Built {
  const where: string[] = ['a.owner_id = ?'];
  const binds: Bind[] = [userId];
  const add = (sql: string, ...b: Bind[]) => {
    where.push(sql);
    binds.push(...b);
  };

  if (has(body, 'visibility')) {
    const v = oneOf(body.visibility, 'visibility', VISIBILITIES);
    if (v === 'locked' && !opts.elevated) throw new ImmichError(401, 'Elevated permissions are required to search locked assets');
    add('a.visibility = ?', v);
  } else if (!opts.elevated) {
    where.push("a.visibility != 'locked'");
  }
  if (opts.defaultHidden && body.visibility !== 'hidden') where.push("a.visibility != 'hidden'");

  if (has(body, 'type')) add('a.type = ?', oneOf(body.type, 'type', TYPES));
  if (has(body, 'isFavorite')) add('a.is_favorite = ?', bool(body.isFavorite, 'isFavorite') ? 1 : 0);
  if (has(body, 'isMotion')) where.push(`a.live_photo_video_id IS ${bool(body.isMotion, 'isMotion') ? 'NOT ' : ''}NULL`);
  if (has(body, 'isOffline') && bool(body.isOffline, 'isOffline')) where.push(NEVER); // we never mark assets offline
  if (has(body, 'isEncoded') && bool(body.isEncoded, 'isEncoded')) where.push(NEVER); // no encoded-video tracking yet
  // C5: Immich isNotInAlbum (ignored when albumIds is set, which matches nothing here anyway)
  if (has(body, 'isNotInAlbum') && bool(body.isNotInAlbum, 'isNotInAlbum')) where.push(`NOT ${IN_ANY_ALBUM}`);
  if (has(body, 'id')) {
    const id = str(body.id, 'id');
    if (!UUID.test(id)) bad('id must be a UUID');
    add('a.id = ?', id);
  }
  if (has(body, 'checksum')) add('a.checksum = ?', str(body.checksum, 'checksum'));
  if (has(body, 'deviceId')) add('a.device_id = ?', str(body.deviceId, 'deviceId'));
  if (has(body, 'libraryId') && body.libraryId !== null) where.push(NEVER); // no libraries
  if (has(body, 'albumIds') && body.albumIds !== null && uuidArray(body.albumIds, 'albumIds').length > 0) where.push(NEVER); // no album search yet
  // phase 4 E: Immich hasPeople for the flat personIds (every listed person has a visible face on the asset)
  if (has(body, 'personIds') && body.personIds !== null) {
    const ids = uuidArray(body.personIds, 'personIds');
    if (ids.length > 0) {
      const m = personMatch(ids, 'all');
      add(m.where[0], ...m.binds);
    }
  }
  // stream E + G: Immich hasTags (every listed tag or a descendant) for a non-empty list; null means untagged.
  if (has(body, 'tagIds')) {
    if (body.tagIds === null) where.push(`NOT ${HAS_ANY_TAG}`);
    else {
      const ids = uuidArray(body.tagIds, 'tagIds');
      if (ids.length > 0) {
        const m = tagMatch(ids, 'all');
        add(m.where[0], ...m.binds);
      }
    }
  }
  for (const k of ['encodedVideoPath', 'previewPath', 'thumbnailPath']) {
    if (has(body, k) && body[k]) where.push(NEVER);
  }
  if (has(body, 'ocr') && body.ocr) where.push(NEVER);

  const dates: [string, string, string, string][] = [
    ['createdAfter', 'a.created_at', '>=', 'createdAfter'], ['createdBefore', 'a.created_at', '<=', 'createdBefore'],
    ['updatedAfter', 'a.updated_at', '>=', 'updatedAfter'], ['updatedBefore', 'a.updated_at', '<=', 'updatedBefore'],
    ['trashedAfter', 'a.deleted_at', '>=', 'trashedAfter'], ['trashedBefore', 'a.deleted_at', '<=', 'trashedBefore'],
    ['takenAfter', 'a.file_created_at', '>=', 'takenAfter'], ['takenBefore', 'a.file_created_at', '<=', 'takenBefore'],
  ];
  for (const [key, col, op] of dates) if (has(body, key)) add(`${col} ${op} ?`, iso(body[key], key));

  const exifEq: [string, string][] = [
    ['city', 'e.city'], ['state', 'e.state'], ['country', 'e.country'], ['make', 'e.make'], ['model', 'e.model'], ['lensModel', 'e.lens_model'],
  ];
  for (const [key, col] of exifEq) {
    if (!has(body, key)) continue;
    if (body[key] === null) where.push(`e.asset_id IS NOT NULL AND ${col} IS NULL`);
    else add(`${col} = ?`, str(body[key], key));
  }
  if (has(body, 'rating')) {
    if (body.rating === null) where.push('e.asset_id IS NOT NULL AND e.rating IS NULL');
    else add('e.rating = ?', int(body.rating, 'rating', 1, 5));
  }
  const contains: [string, string][] = [['originalFileName', 'a.original_file_name'], ['originalPath', 'a.original_path'], ['description', 'e.description']];
  for (const [key, col] of contains) {
    if (has(body, key) && body[key] !== '') add(`${col} LIKE ? ESCAPE '\\'`, likePattern(str(body[key], key), key));
  }

  const withDeleted = (has(body, 'withDeleted') && bool(body.withDeleted, 'withDeleted')) ||
    has(body, 'trashedAfter') || has(body, 'trashedBefore') || (has(body, 'isOffline') && bool(body.isOffline, 'isOffline'));
  if (!withDeleted) where.push('a.deleted_at IS NULL');
  return capBinds({ where, binds });
}

// ---- structured (3.2+) shape ---------------------------------------------------------------

type Col = { col: string; kind: 'str' | 'date' | 'num' | 'enum'; values?: string[] };

const FILTER_COLUMNS: Record<string, Col> = {
  id: { col: 'a.id', kind: 'str' },
  checksum: { col: 'a.checksum', kind: 'str' },
  city: { col: 'e.city', kind: 'str' },
  state: { col: 'e.state', kind: 'str' },
  country: { col: 'e.country', kind: 'str' },
  make: { col: 'e.make', kind: 'str' },
  model: { col: 'e.model', kind: 'str' },
  lensModel: { col: 'e.lens_model', kind: 'str' },
  description: { col: 'e.description', kind: 'str' },
  originalFileName: { col: 'a.original_file_name', kind: 'str' },
  originalPath: { col: 'a.original_path', kind: 'str' },
  createdAt: { col: 'a.created_at', kind: 'date' },
  updatedAt: { col: 'a.updated_at', kind: 'date' },
  takenAt: { col: 'a.file_created_at', kind: 'date' },
  trashedAt: { col: 'a.deleted_at', kind: 'date' },
  fileSizeInBytes: { col: 'e.file_size_in_byte', kind: 'num' },
  rating: { col: 'e.rating', kind: 'num' },
  type: { col: 'a.type', kind: 'enum', values: TYPES },
  visibility: { col: 'a.visibility', kind: 'enum', values: VISIBILITIES },
};

function operand(c: Col, v: unknown, name: string): Bind {
  if (v === null) return null;
  switch (c.kind) {
    case 'date': return iso(v, name);
    case 'num': return typeof v === 'number' ? v : bad(`${name} must be a number`);
    case 'enum': return oneOf(v, name, c.values ?? []);
    default: return str(v, name);
  }
}

function comparison(c: Col, f: unknown, name: string, out: Built): void {
  if (f === null || typeof f !== 'object' || Array.isArray(f)) return bad(`${name} must be an object`);
  const o = f as Obj;
  const sqlOps: Record<string, string> = { gt: '>', gte: '>=', lt: '<', lte: '<=' };
  for (const [op, v] of Object.entries(o)) {
    const label = `${name}.${op}`;
    if (op === 'eq' || op === 'ne') {
      const b = operand(c, v, label);
      if (b === null) out.where.push(`${c.col} IS ${op === 'ne' ? 'NOT ' : ''}NULL`);
      else {
        out.where.push(`${c.col} ${op === 'eq' ? '=' : '!='} ?`);
        out.binds.push(b);
      }
    } else if (Object.hasOwn(sqlOps, op)) {
      out.where.push(`${c.col} ${sqlOps[op]} ?`);
      out.binds.push(operand(c, v, label));
    } else if (op === 'in' || op === 'notIn') {
      if (!Array.isArray(v) || v.length > 90) return bad(`${label} must be an array of at most 90 values`);
      if (v.length === 0) out.where.push(op === 'in' ? NEVER : '1');
      else {
        out.where.push(`${c.col} ${op === 'in' ? 'IN' : 'NOT IN'} (${v.map(() => '?').join(', ')})`);
        out.binds.push(...v.map((x, i) => operand(c, x, `${label}[${i}]`)));
      }
    } else if (['like', 'notLike', 'startsWith', 'endsWith'].includes(op) && c.kind === 'str') {
      const pattern = likePattern(str(v, label), label, op === 'startsWith' ? 'starts' : op === 'endsWith' ? 'ends' : 'contains');
      out.where.push(`${c.col} ${op === 'notLike' ? 'NOT LIKE' : 'LIKE'} ? ESCAPE '\\'`);
      out.binds.push(pattern);
    } else return bad(`${name}.${op} is not a supported operator`);
  }
}

function boolFilter(f: unknown, name: string): boolean {
  if (f === null || typeof f !== 'object' || typeof (f as Obj).eq !== 'boolean') return bad(`${name}.eq must be a boolean`);
  return (f as Obj).eq as boolean;
}

// stream E + G: tag filters. A tag matches assets tagged with it or any descendant (Immich's tag_closure), and only
// the asset owner's tags count (tags are per user; the asset rows are already owner-scoped).
const TAG_TREE = (n: number) =>
  `WITH RECURSIVE d(anc, id) AS (SELECT t.id, t.id FROM tags t WHERE t.user_id = a.owner_id AND t.id IN (${Array(n).fill('?').join(', ')})
     UNION SELECT d.anc, t.id FROM tags t JOIN d ON t.parent_id = d.id)`;
const HAS_ANY_TAG = 'EXISTS (SELECT 1 FROM tag_asset ta WHERE ta.asset_id = a.id)';
const IN_ANY_ALBUM = 'EXISTS (SELECT 1 FROM album_assets aa WHERE aa.asset_id = a.id)';

/** Immich hasTags / tagIdsPredicates: `any` = some listed tag matches; `all` = every listed tag matches. */
function tagMatch(ids: string[], mode: 'any' | 'all'): Built {
  const unique = [...new Set(ids)];
  const tree = TAG_TREE(unique.length);
  if (mode === 'any' || unique.length === 1) {
    return { where: [`EXISTS (${tree} SELECT 1 FROM tag_asset ta JOIN d ON ta.tag_id = d.id WHERE ta.asset_id = a.id)`], binds: unique };
  }
  return {
    where: [`(${tree} SELECT count(DISTINCT d.anc) FROM tag_asset ta JOIN d ON ta.tag_id = d.id WHERE ta.asset_id = a.id) = ${unique.length}`],
    binds: unique,
  };
}

// phase 4 E: people filters over visible, non-deleted faces (Immich hasAnyPerson / hasAllPeople / hasPeople)
const FACE_ON_ASSET = 'FROM asset_faces f WHERE f.asset_id = a.id AND f.deleted_at IS NULL AND f.is_visible = 1';
const HAS_ANY_PERSON = `EXISTS (SELECT 1 ${FACE_ON_ASSET} AND f.person_group_id IS NOT NULL)`;

function personMatch(ids: string[], mode: 'any' | 'all'): Built {
  const unique = [...new Set(ids.map((id) => id.toLowerCase()))];
  const marks = unique.map(() => '?').join(', ');
  if (mode === 'any' || unique.length === 1) {
    return { where: [`EXISTS (SELECT 1 ${FACE_ON_ASSET} AND f.person_group_id IN (${marks}))`], binds: unique };
  }
  return { where: [`(SELECT count(DISTINCT f.person_group_id) ${FACE_ON_ASSET} AND f.person_group_id IN (${marks})) = ${unique.length}`], binds: unique };
}

function idsFilter(f: unknown, name: string, out: Built): void {
  if (f === null || typeof f !== 'object') return bad(`${name} must be an object`);
  for (const k of ['any', 'all', 'none']) {
    const ids = (f as Obj)[k];
    if (ids === undefined) continue;
    const list = uuidArray(ids, `${name}.${k}`);
    if (name === 'tagIds') {
      if (list.length === 0) {
        if (k !== 'none') out.where.push(NEVER); // Immich: an empty any/all list matches nothing; an empty none excludes nothing
        continue;
      }
      const m = tagMatch(list, k === 'all' ? 'all' : 'any');
      out.where.push(k === 'none' ? `NOT ${m.where[0]}` : m.where[0]);
      out.binds.push(...m.binds);
      continue;
    }
    if (name === 'personIds') {
      // phase 4 E: same empty-list rules as tags
      if (list.length === 0) {
        if (k !== 'none') out.where.push(NEVER);
        continue;
      }
      const m = personMatch(list, k === 'all' ? 'all' : 'any');
      out.where.push(k === 'none' ? `NOT ${m.where[0]}` : m.where[0]);
      out.binds.push(...m.binds);
      continue;
    }
    if (k !== 'none' && list.length > 0) out.where.push(NEVER); // no albums/people yet
  }
}

function branch(f: unknown, name: string): Built {
  if (f === null || typeof f !== 'object' || Array.isArray(f)) return bad(`${name} must be an object`);
  const o = f as Obj;
  const out: Built = { where: [], binds: [] };
  for (const [key, v] of Object.entries(o)) {
    if (v === undefined || key === 'or') continue;
    const col = Object.hasOwn(FILTER_COLUMNS, key) ? FILTER_COLUMNS[key] : undefined;
    if (col) {
      if (key === 'type') comparison(col, v, 'type', out);
      else comparison(col, v, key, out);
    } else if (key === 'isFavorite') out.where.push(`a.is_favorite = ${boolFilter(v, key) ? 1 : 0}`);
    else if (key === 'isMotion') out.where.push(`a.live_photo_video_id IS ${boolFilter(v, key) ? 'NOT ' : ''}NULL`);
    else if (key === 'isOffline' || key === 'isEncoded') {
      if (boolFilter(v, key)) out.where.push(NEVER);
    } else if (key === 'hasTags') {
      out.where.push(boolFilter(v, key) ? HAS_ANY_TAG : `NOT ${HAS_ANY_TAG}`); // stream E + G
    } else if (key === 'hasAlbums') {
      out.where.push(boolFilter(v, key) ? IN_ANY_ALBUM : `NOT ${IN_ANY_ALBUM}`); // C5
    } else if (key === 'hasPeople') {
      out.where.push(boolFilter(v, key) ? HAS_ANY_PERSON : `NOT ${HAS_ANY_PERSON}`); // phase 4 E
    } else if (key === 'albumIds' || key === 'personIds' || key === 'tagIds') idsFilter(v, key, out);
    else if (key === 'libraryId') {
      if (v === null || typeof v !== 'object') bad('libraryId must be an object');
      const eq = (v as Obj).eq;
      if (eq !== undefined && eq !== null) out.where.push(NEVER);
    } else if (key === 'ocr') out.where.push(NEVER);
    else if (key === 'encodedVideoPath') out.where.push(NEVER);
    else bad(`unknown filter field ${name}.${key}`);
  }
  if (o.trashedAt === undefined) out.where.push('a.deleted_at IS NULL');
  return out;
}

const mentionsLocked = (f: unknown): boolean => {
  const v = (f as Obj | undefined)?.visibility as Obj | undefined;
  return !!v && (v.eq === 'locked' || (Array.isArray(v.in) && v.in.includes('locked')));
};

/** `elevated` (C3): Immich applyLockedVisibilityPolicy returns the filter unchanged for an elevated session. */
export function filterCriteria(filter: unknown, userId: string, opts: { elevated?: boolean } = {}): Built {
  if (filter !== undefined && (filter === null || typeof filter !== 'object' || Array.isArray(filter))) bad('filter must be an object');
  const f = (filter ?? {}) as Obj;
  const branches = f.or === undefined ? [] : Array.isArray(f.or) ? (f.or as unknown[]) : bad('filter.or must be an array');
  if (!opts.elevated && [f, ...branches].some(mentionsLocked)) throw new ImmichError(401, 'Elevated permissions are required to search locked assets');

  const where = opts.elevated ? ['a.owner_id = ?'] : ['a.owner_id = ?', "a.visibility != 'locked'"];
  const binds: Bind[] = [userId];
  const top = branch(f, 'filter');
  where.push(...top.where);
  binds.push(...top.binds);
  if (branches.length > 0) {
    const parts = branches.map((b, i) => {
      const r = branch(b, `filter.or[${i}]`);
      return { sql: `(${r.where.length ? r.where.join(' AND ') : '1'})`, binds: r.binds };
    });
    where.push(`(${parts.map((p) => p.sql).join(' OR ')})`);
    for (const p of parts) binds.push(...p.binds);
  }
  return capBinds({ where, binds });
}

// ---- ordering and result mapping -----------------------------------------------------------

const ORDER_COLUMNS: Record<string, string> = {
  fileCreatedAt: 'a.file_created_at',
  localDateTime: 'a.local_date_time',
  fileSizeInBytes: 'e.file_size_in_byte',
  rating: 'e.rating',
};

export function structuredOrder(orderBy: unknown): string {
  let field = 'fileCreatedAt';
  let dir = 'desc';
  if (orderBy !== undefined) {
    if (orderBy === null || typeof orderBy !== 'object') bad('orderBy must be an object');
    const o = orderBy as Obj;
    if (o.field !== undefined) field = oneOf(o.field, 'orderBy.field', Object.keys(ORDER_COLUMNS));
    if (o.direction !== undefined) dir = oneOf(o.direction, 'orderBy.direction', ['asc', 'desc']);
  }
  const D = dir.toUpperCase();
  const nullable = field === 'fileSizeInBytes' || field === 'rating';
  return `${nullable ? `${ORDER_COLUMNS[field]} IS NULL, ` : ''}${ORDER_COLUMNS[field]} ${D}, a.id ${D}`;
}

export function encodeCursor(offset: number): string {
  return btoa(JSON.stringify({ offset })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeCursor(cursor: unknown): number {
  if (cursor === undefined) return 0;
  try {
    const raw = atob(String(cursor).replace(/-/g, '+').replace(/_/g, '/'));
    const { offset } = JSON.parse(raw) as { offset: unknown };
    if (typeof offset === 'number' && Number.isInteger(offset) && offset >= 0) return offset;
  } catch {
    /* fall through */
  }
  return bad('Invalid cursor');
}

const EXIF_COLUMNS: (keyof ExifRow)[] = [
  'asset_id', 'owner_id', 'make', 'model', 'lens_model', 'exposure_time', 'f_number', 'focal_length', 'iso', 'latitude', 'longitude',
  'city', 'state', 'country', 'date_time_original', 'modify_date', 'time_zone', 'orientation', 'rating', 'description',
  'exif_image_width', 'exif_image_height', 'file_size_in_byte', 'profile_description', 'projection_type', 'fps', 'update_id',
];

export const ASSET_WITH_EXIF_SELECT = `a.*, ${EXIF_COLUMNS.map((c) => `e.${c} AS x_${c}`).join(', ')}`;

export function splitRow(r: Record<string, any>): { asset: AssetRow; exif: ExifRow | null } {
  const exif: Record<string, unknown> = {};
  const asset: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (k.startsWith('x_')) exif[k.slice(2)] = v;
    else asset[k] = v;
  }
  return { asset: asset as unknown as AssetRow, exif: exif.asset_id === null ? null : (exif as unknown as ExifRow) };
}

export const FROM = 'FROM assets a LEFT JOIN asset_exif e ON e.asset_id = a.id';

/** Integer query/body size with Immich's bounds. */
export function readSize(v: unknown, fallback: number): number {
  return v === undefined ? fallback : int(v, 'size', 1, 1000);
}

export function readPage(v: unknown): number {
  return v === undefined ? 1 : int(v, 'page', 1, 1_000_000);
}

export { bool as readBool, int as readInt, iso as readIso, oneOf as readOneOf };
