// Phase 4 E: People and Faces endpoints (Immich person.controller.ts, face.controller.ts, person.service.ts).
// One cluster group per user and no person sharing: a person is the caller's own `people` row, and the sharing
// arrays in responses are always empty.
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { canReadAsset } from '../access/assets';
import { requireAssetAccess } from '../assets/access';
import { requireAuth } from '../auth/session';
import { commit, tracked, type Tracked } from '../db/changes';
import { ImmichError } from '../http/errors';
import { boolQuery, readDto, UUID_RE, uuidPathParam } from '../http/validate';
import { fromBlob } from '../ml/contract';
import { vectorStore } from '../ml/vectors';
import {
  assignFace,
  commitChunked,
  createNewFeaturePhoto,
  deleteEmptyGroups,
  deletePeople,
  getPerson,
  insertGroup,
  insertPerson,
  mapFace,
  mapPerson,
  NAME_MATCH,
  namePatterns,
  ownedFaceIds,
  refreshStaleFeatureFaces,
  requirePersonAccess,
  syncFaceVectors,
  updatePersonRow,
  type FaceRow,
  type PersonRow,
} from './repo';
import { personThumbnailKey, requestPersonThumbnail } from './thumbnail';

export const peopleRoutes = new Hono<AppEnv>();

const DATE_RE = /^\d{4}-\d\d-\d\d$/;

/** Immich `asset` join of the visible-people query: timeline, not trashed, owned by the caller or a partner, or in an album shared with the caller. */
const VISIBLE_ASSET = (me: string) => `a.visibility = 'timeline' AND a.deleted_at IS NULL AND (
  a.owner_id = ${me}
  OR a.owner_id IN (SELECT shared_by_id FROM partners WHERE shared_with_id = ${me})
  OR EXISTS (SELECT 1 FROM album_assets aa JOIN album_users au ON au.album_id = aa.album_id AND au.user_id = ${me} WHERE aa.asset_id = a.id))`;

/**
 * Immich stores birthDate in a Postgres `date` column, which keeps the date part of whatever it is given: the web app
 * sends a full ISO datetime (luxon `toISO()`, e.g. `1980-05-12T00:00:00.000+03:00`), so the date part is what is kept here.
 */
function birthDate(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value;
  const date = typeof value === 'string' ? value.slice(0, 10) : '';
  if (!DATE_RE.test(date) || Number.isNaN(Date.parse(date)) || Number.isNaN(Date.parse(value))) {
    throw new ImmichError(400, 'birthDate must be a date string (YYYY-MM-DD)');
  }
  if (new Date(date) > new Date()) throw new ImmichError(400, 'Birth date cannot be in the future');
  return date;
}

const hexColor = (value: string | null | undefined) => (typeof value === 'string' && !value.startsWith('#') ? `#${value}` : value);

async function personOr400(db: D1Database, ownerId: string, personGroupId: string): Promise<PersonRow> {
  const p = await getPerson(db, ownerId, personGroupId);
  if (!p) throw new ImmichError(400, 'Person not found');
  return p;
}

async function minimumFaces(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare("SELECT json_extract(preferences, '$.people.minimumFaces') AS n FROM users WHERE id = ?1")
    .bind(userId)
    .first<{ n: number | null }>();
  return typeof row?.n === 'number' ? row.n : 3;
}

interface PeopleFilters {
  isFavorite?: boolean;
  isHidden?: boolean;
  name?: string;
  shared?: boolean;
}

/** Immich getVisiblePeopleQuery plus withFilters. Binds: ?1 caller, ?2 minimum faces, ?3/?4 name patterns. */
function visiblePeopleSql(f: PeopleFilters, withHiddenFilter: boolean): string {
  const where = ['p.owner_id = ?1'];
  if (f.shared) where.push('0'); // sharedById / sharedWithId: no person sharing yet
  if (f.isFavorite !== undefined) where.push(`p.is_favorite = ${f.isFavorite ? 1 : 0}`);
  if (f.isHidden !== undefined) where.push(`p.is_hidden = ${f.isHidden ? 1 : 0}`);
  else if (withHiddenFilter) where.push('p.is_hidden = 0');
  if (f.name !== undefined) where.push(NAME_MATCH('p.name', '?3', '?4'));
  return `SELECT p.*, count(a.id) AS face_count FROM people p
      JOIN asset_faces f ON f.person_group_id = p.person_group_id AND f.deleted_at IS NULL AND f.is_visible = 1
      JOIN assets a ON a.id = f.asset_id AND ${VISIBLE_ASSET('?1')}
      WHERE ${where.join(' AND ')}
      GROUP BY p.owner_id, p.person_group_id
      HAVING p.name != '' OR count(a.id) >= ?2`;
}

async function embeddings(db: D1Database, faceIds: string[]): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  for (let i = 0; i < faceIds.length; i += 500) {
    const { results } = await db
      .prepare('SELECT face_id, embedding FROM face_embeddings WHERE face_id IN (SELECT value FROM json_each(?1))')
      .bind(JSON.stringify(faceIds.slice(i, i + 500)))
      .all<{ face_id: string; embedding: ArrayBuffer }>();
    for (const r of results) out.set(r.face_id, fromBlob(r.embedding));
  }
  return out;
}

function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 1 : 1 - dot / Math.sqrt(na * nb);
}

function uuidQuery(value: string | undefined, what: string): string | undefined {
  if (value === undefined) return undefined;
  if (!UUID_RE.test(value)) throw new ImmichError(400, `${what} must be a UUID`);
  return value.toLowerCase();
}

function intRange(value: string | undefined, what: string, min: number, max: number, dflt: number): number {
  if (value === undefined) return dflt;
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) throw new ImmichError(400, `${what} must be an integer between ${min} and ${max}`);
  return Number(value);
}

peopleRoutes.get('/people', requireAuth, async (c) => {
  const q = c.req.query();
  const me = c.get('auth').user.id;
  const db = c.env.DB;
  const withHidden = boolQuery(q.withHidden, 'withHidden') ?? false;
  const closestPersonId = uuidQuery(q.closestPersonId, 'closestPersonId');
  let closestFaceId = uuidQuery(q.closestAssetId, 'closestAssetId');
  const page = intRange(q.page, 'page', 1, Number.MAX_SAFE_INTEGER, 1);
  const size = intRange(q.size, 'size', 1, 1000, 500);
  uuidQuery(q.sharedById, 'sharedById');
  uuidQuery(q.sharedWithId, 'sharedWithId');
  const filters: PeopleFilters = {
    isFavorite: boolQuery(q.isFavorite, 'isFavorite'),
    isHidden: boolQuery(q.isHidden, 'isHidden'),
    name: q.name,
    shared: q.sharedById !== undefined || q.sharedWithId !== undefined,
  };
  if (closestPersonId) {
    const p = await getPerson(db, me, closestPersonId);
    if (!p?.face_id) throw new ImmichError(404, 'Person not found');
    closestFaceId = p.face_id;
  } else if (closestFaceId) {
    // closestAssetId is a face id; only faces of the caller's cluster group may be compared (no similarity oracle)
    const face = await db
      .prepare('SELECT 1 AS ok FROM asset_faces WHERE id = ?1 AND cluster_group_id = ?2 AND deleted_at IS NULL')
      .bind(closestFaceId, me)
      .first();
    if (!face) throw new ImmichError(400, 'Not found or no face access');
  }
  const minFaces = await minimumFaces(db, me);
  const [prefix, word] = filters.name !== undefined ? namePatterns(filters.name) : ['', ''];
  const binds: unknown[] = filters.name !== undefined ? [me, minFaces, prefix, word] : [me, minFaces];
  const base = visiblePeopleSql(filters, !withHidden);
  const nameOrder = filters.name !== undefined ? ", (lower(name) LIKE ?3 ESCAPE '\\') DESC, length(name)" : '';
  const skip = (page - 1) * size;

  let rows: Array<PersonRow & { face_count: number }>;
  if (closestFaceId) {
    // Immich orders by cosine distance between each feature face and the target face; done here in the Worker.
    const { results } = await db.prepare(`SELECT * FROM (${base}) ORDER BY is_hidden ASC, is_favorite DESC`).bind(...binds).all<PersonRow & { face_count: number }>();
    const vectors = await embeddings(db, [closestFaceId, ...results.map((r) => r.face_id).filter((id): id is string => !!id)]);
    const target = vectors.get(closestFaceId);
    const dist = (r: PersonRow) => (target && r.face_id && vectors.has(r.face_id) ? cosineDistance(vectors.get(r.face_id)!, target) : Infinity);
    rows = results
      .map((r) => ({ r, d: dist(r) }))
      .sort((x, y) => x.r.is_hidden - y.r.is_hidden || y.r.is_favorite - x.r.is_favorite || x.d - y.d)
      .map((x) => x.r)
      .slice(skip, skip + size + 1);
  } else {
    const { results } = await db
      .prepare(
        `SELECT * FROM (${base}) ORDER BY is_hidden ASC, is_favorite DESC, name = '' ASC, face_count DESC,
           CASE WHEN name = '' THEN NULL ELSE name END COLLATE NOCASE ASC NULLS LAST, created_at${nameOrder} LIMIT ${size + 1} OFFSET ${skip}`,
      )
      .bind(...binds)
      .all<PersonRow & { face_count: number }>();
    rows = results;
  }
  const counted = visiblePeopleSql(filters, false);
  const counts = await db
    .prepare(`SELECT count(*) AS total, coalesce(sum(is_hidden), 0) AS hidden FROM (${counted})`)
    .bind(...binds)
    .first<{ total: number; hidden: number }>();
  return c.json({
    people: rows.slice(0, size).map(mapPerson),
    hasNextPage: rows.length > size,
    total: counts?.total ?? 0,
    hidden: counts?.hidden ?? 0,
  });
});

peopleRoutes.post('/people', requireAuth, async (c) => {
  const dto = await readDto(c, 'PersonCreateDto');
  const me = c.get('auth').user.id;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await commit(c.env.DB, [
    insertGroup(c.env.DB, id, me, now),
    insertPerson(
      { ownerId: me, personGroupId: id, name: dto.name, birthDate: birthDate(dto.birthDate), isHidden: dto.isHidden, isFavorite: dto.isFavorite, color: hexColor(dto.color) },
      now,
    ),
  ]);
  return c.json(mapPerson((await getPerson(c.env.DB, me, id))!), 201);
});

type PersonUpdate = {
  name?: string;
  birthDate?: string | null;
  isHidden?: boolean;
  isFavorite?: boolean;
  color?: string | null;
  featureFaceAssetId?: string;
  userId?: string;
};

/** Immich PersonService.update. */
async function updatePerson(env: Env, auth: { userId: string; elevated: boolean }, personGroupId: string, dto: PersonUpdate): Promise<PersonRow> {
  const { userId, featureFaceAssetId: assetId, ...rest } = dto;
  if (![rest.name, rest.birthDate, rest.isHidden, rest.isFavorite, rest.color, assetId].some((v) => v !== undefined)) {
    throw new ImmichError(400, 'At least one of the following fields is required: name, birthDate, isHidden, isFavorite, color, featureFaceAssetId');
  }
  const target = userId ?? auth.userId;
  const personal = [rest.isHidden, rest.isFavorite, rest.color, assetId].some((v) => v !== undefined);
  if (target !== auth.userId && personal) throw new ImmichError(400, 'Only name and birthDate can be updated for other users');
  await requirePersonAccess(env.DB, auth.userId, [{ personGroupId, ownerId: target }], 'person.update');

  const fields: Record<string, unknown> = {};
  if (rest.name !== undefined) fields.name = rest.name;
  if (rest.birthDate !== undefined) fields.birth_date = birthDate(rest.birthDate);
  if (rest.isHidden !== undefined) fields.is_hidden = rest.isHidden ? 1 : 0;
  if (rest.isFavorite !== undefined) fields.is_favorite = rest.isFavorite ? 1 : 0;
  if (rest.color !== undefined) fields.color = hexColor(rest.color);
  if (assetId) {
    if (!UUID_RE.test(assetId)) throw new ImmichError(400, 'featureFaceAssetId must be a UUID');
    if (!(await canReadAsset(env.DB, auth.userId, assetId, { elevated: auth.elevated }))) throw new ImmichError(400, 'Not found or no asset.read access');
    const face = await env.DB.prepare('SELECT id FROM asset_faces WHERE asset_id = ?1 AND person_group_id = ?2 AND deleted_at IS NULL LIMIT 1')
      .bind(assetId, personGroupId)
      .first<{ id: string }>();
    if (!face) throw new ImmichError(400, 'Invalid assetId for feature face or asset is offline');
    fields.face_id = face.id;
  }
  await commit(env.DB, [updatePersonRow(target, personGroupId, fields, new Date().toISOString())]);
  if (assetId) await requestPersonThumbnail(env, personGroupId);
  return (await getPerson(env.DB, target, personGroupId))!;
}

const authOf = (c: { get: (k: 'auth') => { user: { id: string }; hasElevatedPermission?: boolean } }) => ({
  userId: c.get('auth').user.id,
  elevated: c.get('auth').hasElevatedPermission === true,
});

peopleRoutes.put('/people', requireAuth, async (c) => {
  const dto = await readDto(c, 'PeopleUpdateDto');
  const results = [];
  for (const p of dto.people) {
    try {
      await updatePerson(c.env, authOf(c), p.id, p);
      results.push({ id: p.id, success: true });
    } catch (err) {
      if (!(err instanceof ImmichError)) console.error(`Unable to update ${p.id}`, err);
      results.push({ id: p.id, success: false, error: 'unknown' });
    }
  }
  return c.json(results);
});

/** Immich deleteAll: the caller's person rows, their thumbnails, then groups left without people (faces unassigned). */
async function deleteAll(env: Env, me: string, ids: string[], userId: string | undefined): Promise<void> {
  const ownerId = userId ?? me;
  await requirePersonAccess(env.DB, me, ids.map((id) => ({ personGroupId: id, ownerId })), 'person.delete');
  await deletePeople(env, ownerId, ids);
  await deleteEmptyGroups(env, ids);
  await refreshStaleFeatureFaces(env, me);
}

peopleRoutes.delete('/people', requireAuth, async (c) => {
  const dto = await readDto(c, 'PeopleDeleteDto');
  await deleteAll(c.env, c.get('auth').user.id, dto.ids, dto.userId);
  return c.body(null, 204);
});

/** Immich mergePeople: the first id is the target; sources the caller owns move their faces and name/birth date into it. */
async function mergePeople(env: Env, me: string, ids: string[]) {
  if (ids.length < 2) throw new ImmichError(400, 'At least two people are required for merging');
  if (new Set(ids).size !== ids.length) throw new ImmichError(400, 'Cannot merge a person into themselves');
  const { results: owned } = await env.DB.prepare('SELECT * FROM people WHERE owner_id = ?1 AND person_group_id IN (SELECT value FROM json_each(?2))')
    .bind(me, JSON.stringify(ids))
    .all<PersonRow>();
  const rows = new Map(owned.map((p) => [p.person_group_id, p]));
  const results = new Map(ids.map((id) => [id, { id, success: false, error: rows.has(id) ? 'not_found' : 'no_permission' } as { id: string; success: boolean; error?: string }]));
  const [targetId, ...sourceIds] = ids.filter((id) => rows.has(id));
  if (!targetId) return [...results.values()];
  let target = rows.get(targetId)!;
  results.set(targetId, { id: targetId, success: true });
  const now = new Date().toISOString();
  for (const id of sourceIds) {
    const source = rows.get(id)!;
    try {
      const changes: Record<string, unknown> = {};
      if (source.name && !target.name) changes.name = source.name;
      if (source.birth_date && !target.birth_date) changes.birth_date = source.birth_date;
      const items: Array<Tracked | D1PreparedStatement> = [];
      if (Object.keys(changes).length > 0) items.push(updatePersonRow(me, targetId, changes, now));
      const { results: faces } = await env.DB.prepare(
        'SELECT f.id FROM asset_faces f JOIN assets a ON a.id = f.asset_id WHERE f.person_group_id = ?1 AND a.owner_id = ?2',
      )
        .bind(id, me)
        .all<{ id: string }>();
      for (const f of faces) items.push(assignFace(f.id, targetId, now));
      await commitChunked(env.DB, items);
      target = (await getPerson(env.DB, me, targetId))!;
      await deletePeople(env, me, [id]);
      results.set(id, { id, success: true });
    } catch (err) {
      console.error(`Unable to merge ${id} into ${targetId}`, err);
      results.set(id, { id, success: false, error: 'unknown' });
    }
  }
  await deleteEmptyGroups(env, sourceIds);
  await refreshStaleFeatureFaces(env, me);
  return [...results.values()];
}

peopleRoutes.post('/people/merge', requireAuth, async (c) => {
  const dto = await readDto(c, 'MergePersonDto');
  return c.json(await mergePeople(c.env, c.get('auth').user.id, dto.ids));
});

peopleRoutes.get('/people/:id', requireAuth, async (c) => {
  const id = uuidPathParam(c);
  const me = c.get('auth').user.id;
  await requirePersonAccess(c.env.DB, me, [{ personGroupId: id, ownerId: me }], 'person.read');
  return c.json(mapPerson(await personOr400(c.env.DB, me, id)));
});

peopleRoutes.put('/people/:id', requireAuth, async (c) => {
  const id = uuidPathParam(c);
  const dto = await readDto(c, 'PersonUpdateDto');
  return c.json(mapPerson(await updatePerson(c.env, authOf(c), id, dto)));
});

peopleRoutes.delete('/people/:id', requireAuth, async (c) => {
  const id = uuidPathParam(c);
  const dto = await readDto(c, 'PersonDeleteDto');
  await deleteAll(c.env, c.get('auth').user.id, [id], dto.userId);
  return c.body(null, 204);
});

peopleRoutes.post('/people/:id/merge', requireAuth, async (c) => {
  const id = uuidPathParam(c);
  const dto = await readDto(c, 'MergePersonDto');
  return c.json(await mergePeople(c.env, c.get('auth').user.id, [id, ...dto.ids]));
});

peopleRoutes.get('/people/:id/statistics', requireAuth, async (c) => {
  const id = uuidPathParam(c);
  const me = c.get('auth').user.id;
  await requirePersonAccess(c.env.DB, me, [{ personGroupId: id, ownerId: me }], 'person.read');
  const row = await c.env.DB.prepare(
    `SELECT count(DISTINCT a.id) AS n FROM asset_faces f JOIN assets a ON a.id = f.asset_id AND ${VISIBLE_ASSET('?1')}
     WHERE f.person_group_id = ?2 AND f.deleted_at IS NULL AND f.is_visible = 1`,
  )
    .bind(me, id)
    .first<{ n: number }>();
  return c.json({ assets: row?.n ?? 0 });
});

peopleRoutes.get('/people/:id/thumbnail', requireAuth, async (c) => {
  const id = uuidPathParam(c);
  const me = c.get('auth').user.id;
  await requirePersonAccess(c.env.DB, me, [{ personGroupId: id, ownerId: me }], 'person.read');
  const person = await personOr400(c.env.DB, me, id);
  const obj = await c.env.MEDIA.get(person.thumbnail_key || personThumbnailKey(id));
  if (!obj) throw new ImmichError(404, 'Not Found');
  return new Response(obj.body, {
    headers: {
      'content-type': 'image/jpeg',
      'content-length': String(obj.size),
      'cache-control': 'private, no-cache, no-transform',
    },
  });
});

/** Immich reassignFaces: the faces of each `{personId, assetId}` the caller owns move to `:id`. */
peopleRoutes.put('/people/:id/reassign', requireAuth, async (c) => {
  const id = uuidPathParam(c);
  const dto = await readDto(c, 'AssetFaceUpdateDto');
  const me = c.get('auth').user.id;
  await requirePersonAccess(c.env.DB, me, [{ personGroupId: id, ownerId: me }, ...dto.data.map((d) => ({ personGroupId: d.personId, ownerId: d.userId ?? me }))], 'person.update');
  const person = await personOr400(c.env.DB, me, id);
  const result = [];
  const refresh = new Map<string, { ownerId: string; personGroupId: string }>();
  const now = new Date().toISOString();
  for (const item of dto.data) {
    const { results: faces } = await c.env.DB.prepare('SELECT id FROM asset_faces WHERE asset_id = ?1 AND person_group_id = ?2 AND deleted_at IS NULL')
      .bind(item.assetId, item.personId)
      .all<{ id: string }>();
    const allowed = await ownedFaceIds(c.env.DB, me, faces.map((f) => f.id));
    for (const f of faces) {
      if (!allowed.has(f.id)) continue;
      if (person.face_id === null) refresh.set(id, { ownerId: me, personGroupId: id });
      const old = await getPerson(c.env.DB, me, item.personId);
      if (old?.face_id === f.id) refresh.set(item.personId, { ownerId: me, personGroupId: item.personId });
      await commit(c.env.DB, [assignFace(f.id, id, now)]);
    }
    result.push(mapPerson(person));
  }
  if (refresh.size > 0) await createNewFeaturePhoto(c.env, [...refresh.values()]);
  await refreshStaleFeatureFaces(c.env, me);
  return c.json(result);
});

// ---- faces ----

peopleRoutes.get('/faces', requireAuth, async (c) => {
  const assetId = c.req.query('id');
  if (!assetId || !UUID_RE.test(assetId)) throw new ImmichError(400, 'id must be a UUID');
  const me = c.get('auth').user.id;
  if (!(await canReadAsset(c.env.DB, me, assetId, { elevated: c.get('auth').hasElevatedPermission === true }))) {
    throw new ImmichError(400, 'Not found or no asset.read access');
  }
  const { results } = await c.env.DB.prepare(
    `SELECT f.*, p.owner_id AS p_owner_id FROM asset_faces f LEFT JOIN people p ON p.person_group_id = f.person_group_id AND p.owner_id = ?2
     WHERE f.asset_id = ?1 AND f.deleted_at IS NULL AND f.is_visible = 1 ORDER BY f.x1 ASC`,
  )
    .bind(assetId, me)
    .all<FaceRow & { p_owner_id: string | null }>();
  const people = new Map<string, PersonRow>();
  for (const f of results) {
    if (f.p_owner_id && f.person_group_id && !people.has(f.person_group_id)) people.set(f.person_group_id, (await getPerson(c.env.DB, me, f.person_group_id))!);
  }
  return c.json(results.map((f) => mapFace(f, f.p_owner_id && f.person_group_id ? people.get(f.person_group_id)! : null)));
});

/** Immich createFace: a manual face (no embedding) on an asset the caller may update, for one of the caller's people. */
peopleRoutes.post('/faces', requireAuth, async (c) => {
  const dto = await readDto(c, 'AssetFaceCreateDto');
  const me = c.get('auth').user.id;
  const assets = await requireAssetAccess(c, [dto.assetId], 'update');
  await requirePersonAccess(c.env.DB, me, [{ personGroupId: dto.personId, ownerId: me }], 'person.read');
  const person = await personOr400(c.env.DB, me, dto.personId);
  const asset = assets.get(dto.assetId)!;
  const now = new Date().toISOString();
  await commit(c.env.DB, [
    tracked(
      `INSERT INTO asset_faces (id, asset_id, owner_id, cluster_group_id, person_group_id, image_width, image_height, x1, y1, x2, y2, source_type, updated_at, update_id)
       VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'manual', ?11, :cursor)`,
      crypto.randomUUID(),
      asset.id,
      asset.owner_id,
      person.person_group_id,
      dto.imageWidth,
      dto.imageHeight,
      Math.round(dto.x),
      Math.round(dto.y),
      Math.round(dto.x + dto.width),
      Math.round(dto.y + dto.height),
      now,
    ),
  ]);
  if (!person.face_id) await createNewFeaturePhoto(c.env, [{ ownerId: me, personGroupId: person.person_group_id }]);
  return c.body(null, 201);
});

/** Immich reassignFacesById: one face (on an asset the caller owns) moves to the person in the path. */
peopleRoutes.put('/faces/:id', requireAuth, async (c) => {
  const personGroupId = uuidPathParam(c);
  const dto = await readDto(c, 'FaceDto');
  const me = c.get('auth').user.id;
  await requirePersonAccess(c.env.DB, me, [{ personGroupId, ownerId: me }], 'person.update');
  if (!(await ownedFaceIds(c.env.DB, me, [dto.id])).has(dto.id)) throw new ImmichError(400, 'Not found or no person.create access');
  const face = await c.env.DB.prepare('SELECT * FROM asset_faces WHERE id = ?1 AND deleted_at IS NULL').bind(dto.id).first<FaceRow>();
  if (!face) throw new ImmichError(400, 'Face not found');
  const person = await personOr400(c.env.DB, me, personGroupId);
  await commit(c.env.DB, [assignFace(face.id, personGroupId, new Date().toISOString())]);
  await syncFaceVectors(c.env, [face.id]);
  const refresh = [];
  if (person.face_id === null) refresh.push({ ownerId: me, personGroupId });
  if (face.person_group_id) {
    const old = await getPerson(c.env.DB, me, face.person_group_id);
    if (old?.face_id === face.id) refresh.push({ ownerId: me, personGroupId: face.person_group_id });
  }
  if (refresh.length > 0) await createNewFeaturePhoto(c.env, refresh);
  await refreshStaleFeatureFaces(c.env, me);
  return c.json(mapPerson(await personOr400(c.env.DB, me, personGroupId)));
});

/** Immich deleteFace: `force` removes the face (audit row, embedding, vector); otherwise it is soft-deleted. */
peopleRoutes.delete('/faces/:id', requireAuth, async (c) => {
  const id = uuidPathParam(c);
  const dto = await readDto(c, 'AssetFaceDeleteDto');
  const me = c.get('auth').user.id;
  if (!(await ownedFaceIds(c.env.DB, me, [id])).has(id)) throw new ImmichError(400, 'Not found or no face.delete access');
  const now = new Date().toISOString();
  if (dto.force) {
    await commit(c.env.DB, [
      tracked(
        `INSERT INTO asset_face_audit (id, face_id, asset_id, owner_id, cluster_group_id, deleted_at)
         SELECT :cursor, id, asset_id, owner_id, cluster_group_id, ?2 FROM asset_faces WHERE id = ?1`,
        id,
        now,
      ),
      c.env.DB.prepare('DELETE FROM face_embeddings WHERE face_id = ?1').bind(id),
      c.env.DB.prepare('DELETE FROM asset_faces WHERE id = ?1').bind(id),
    ]);
    await vectorStore(c.env, 'face')?.deleteByIds([id]);
  } else {
    await commit(c.env.DB, [tracked('UPDATE asset_faces SET deleted_at = ?2, updated_at = ?2, update_id = :cursor WHERE id = ?1', id, now)]);
    // a soft-deleted face is no clustering neighbour; its vector (and assigned flag) leaves the index
    await vectorStore(c.env, 'face')?.deleteByIds([id]);
  }
  await refreshStaleFeatureFaces(c.env, me); // the face may have been a person's feature face
  return c.body(null, 204);
});

/** Immich getByName for GET /search/person: the caller's people matching `name`, closest first, at most 100. */
export async function searchPeopleByName(db: D1Database, userId: string, name: string, withHidden: boolean) {
  const [prefix, word] = namePatterns(name);
  const { results } = await db
    .prepare(
      `SELECT * FROM people WHERE owner_id = ?1 AND ${NAME_MATCH('name', '?2', '?3')} ${withHidden ? '' : 'AND is_hidden = 0'}
       ORDER BY (lower(name) LIKE ?2 ESCAPE '\\') DESC, length(name), name COLLATE NOCASE LIMIT 100`,
    )
    .bind(userId, prefix, word)
    .all<PersonRow>();
  return results.map(mapPerson);
}
