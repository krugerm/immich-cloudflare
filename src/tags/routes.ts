import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { allowLocked } from '../assets/access';
import { requireAuth } from '../auth/session';
import type { Dto } from '../gen/dto';
import { ImmichError } from '../http/errors';
import { chunks, colorValue, json, jsonBody, uuidArray, uuidParam } from './util';

export interface TagRow {
  id: string;
  user_id: string;
  value: string;
  color: string | null;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
}

export function mapTag(t: TagRow): Dto<'TagResponseDto'> {
  const dto: Dto<'TagResponseDto'> = {
    id: t.id,
    name: t.value.split('/').at(-1) as string,
    value: t.value,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
  if (t.parent_id) dto.parentId = t.parent_id;
  if (t.color) dto.color = t.color;
  return dto;
}

const CHUNK = 500;
export const MAX_UPSERT = 100;
const DESCENDANTS = `WITH RECURSIVE d(id) AS (SELECT id FROM tags WHERE id = ?1 UNION ALL SELECT t.id FROM tags t JOIN d ON t.parent_id = d.id)`;

/** Immich's requireAccess: ids the user does not own (or that do not exist) are a 400. */
async function requireOwnedTag(db: D1Database, userId: string, id: string, permission: string): Promise<TagRow> {
  const tag = await db.prepare('SELECT * FROM tags WHERE id = ?1 AND user_id = ?2').bind(id, userId).first<TagRow>();
  if (!tag) throw new ImmichError(400, `Not found or no ${permission} access`);
  return tag;
}

/** SQL condition on `a` that excludes locked-folder assets unless the session is PIN-elevated (asset.update access). */
const unlockedUnless = (elevated: boolean) => (elevated ? '1' : "a.visibility != 'locked'");

/** The caller's own assets among `ids` it may update (locked ones only from an elevated session). */
async function ownedAssetIds(db: D1Database, userId: string, ids: string[], elevated: boolean): Promise<Set<string>> {
  const out = new Set<string>();
  for (const part of chunks([...new Set(ids)], CHUNK)) {
    const { results } = await db
      .prepare(`SELECT a.id FROM assets a WHERE a.owner_id = ?1 AND a.id IN (SELECT value FROM json_each(?2)) AND ${unlockedUnless(elevated)}`)
      .bind(userId, json(part))
      .all<{ id: string }>();
    for (const r of results) out.add(r.id);
  }
  return out;
}

async function taggedAssetIds(db: D1Database, tagId: string, ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const part of chunks([...new Set(ids)], CHUNK)) {
    const { results } = await db
      .prepare('SELECT asset_id FROM tag_asset WHERE tag_id = ?1 AND asset_id IN (SELECT value FROM json_each(?2))')
      .bind(tagId, json(part))
      .all<{ asset_id: string }>();
    for (const r of results) out.add(r.asset_id);
  }
  return out;
}

export const tagRoutes = new Hono<AppEnv>();

tagRoutes.get('/tags', requireAuth, async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM tags WHERE user_id = ?1 ORDER BY value').bind(c.get('auth').user.id).all<TagRow>();
  return c.json(results.map(mapTag));
});

tagRoutes.post('/tags', requireAuth, async (c) => {
  const userId = c.get('auth').user.id;
  const body = await jsonBody(c);
  if (typeof body.name !== 'string' || body.name.includes('/')) throw new ImmichError(400, 'name must be a string without slashes');
  if (body.parentId !== undefined && body.parentId !== null) uuidParam(body.parentId as string, 'parentId');
  const color = colorValue(body.color);
  const parent = body.parentId ? await requireOwnedTag(c.env.DB, userId, body.parentId as string, 'tag.read') : null;
  const value = parent ? `${parent.value}/${body.name}` : body.name;
  const duplicate = await c.env.DB.prepare('SELECT id FROM tags WHERE user_id = ?1 AND value = ?2').bind(userId, value).first();
  if (duplicate) throw new ImmichError(400, 'A tag with that name already exists');
  const now = new Date().toISOString();
  const tag: TagRow = { id: crypto.randomUUID(), user_id: userId, value, color: color ?? null, parent_id: parent?.id ?? null, created_at: now, updated_at: now };
  await c.env.DB.prepare('INSERT INTO tags (id, user_id, value, color, parent_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)')
    .bind(tag.id, userId, value, tag.color, tag.parent_id, now)
    .run();
  return c.json(mapTag(tag), 201);
});

tagRoutes.put('/tags', requireAuth, async (c) => {
  const userId = c.get('auth').user.id;
  const body = await jsonBody(c);
  if (!Array.isArray(body.tags) || body.tags.some((t) => typeof t !== 'string')) throw new ImmichError(400, 'tags must be an array of strings');
  if (body.tags.length > MAX_UPSERT) throw new ImmichError(400, `tags must contain at most ${MAX_UPSERT} items`);
  const db = c.env.DB;
  const { results } = await db.prepare('SELECT * FROM tags WHERE user_id = ?1').bind(userId).all<TagRow>();
  const byValue = new Map(results.map((t) => [t.value, t]));
  const now = new Date().toISOString();
  const inserts: D1PreparedStatement[] = [];
  const leaves: TagRow[] = [];
  for (const path of new Set(body.tags as string[])) {
    let parent: TagRow | undefined;
    for (const part of path.split('/').filter(Boolean)) {
      const value = parent ? `${parent.value}/${part}` : part;
      let tag = byValue.get(value);
      if (!tag) {
        tag = { id: crypto.randomUUID(), user_id: userId, value, color: null, parent_id: parent?.id ?? null, created_at: now, updated_at: now };
        byValue.set(value, tag);
        inserts.push(
          db.prepare('INSERT INTO tags (id, user_id, value, color, parent_id, created_at, updated_at) VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?5)').bind(tag.id, userId, value, tag.parent_id, now),
        );
      }
      parent = tag;
    }
    if (parent) leaves.push(parent);
  }
  try {
    for (const part of chunks(inserts, 100)) await db.batch(part);
  } catch (err) {
    if (String(err).includes('UNIQUE')) throw new ImmichError(400, 'A tag with that name already exists'); // concurrent upsert
    throw err;
  }
  return c.json(leaves.map(mapTag));
});

// Registered before /tags/:id so that "assets" is not read as an id.
tagRoutes.put('/tags/assets', requireAuth, async (c) => {
  const userId = c.get('auth').user.id;
  const body = await jsonBody(c);
  const tagIds = uuidArray(body.tagIds, 'tagIds');
  const assetIds = uuidArray(body.assetIds, 'assetIds');
  let count = 0;
  for (const part of chunks([...new Set(assetIds)], CHUNK)) {
    // Ids that are not the caller's own are dropped silently, as in Immich's checkAccess.
    const res = await c.env.DB.prepare(
      `INSERT OR IGNORE INTO tag_asset (tag_id, asset_id)
       SELECT t.id, a.id FROM tags t, assets a
       WHERE t.user_id = ?1 AND t.id IN (SELECT value FROM json_each(?2))
         AND a.owner_id = ?1 AND a.id IN (SELECT value FROM json_each(?3)) AND ${unlockedUnless(allowLocked(c))}`,
    )
      .bind(userId, json([...new Set(tagIds)]), json(part))
      .run();
    count += res.meta.changes ?? 0;
  }
  return c.json({ count });
});

tagRoutes.get('/tags/:id', requireAuth, async (c) => {
  const id = uuidParam(c.req.param('id'), 'id');
  return c.json(mapTag(await requireOwnedTag(c.env.DB, c.get('auth').user.id, id, 'tag.read')));
});

tagRoutes.put('/tags/:id', requireAuth, async (c) => {
  const db = c.env.DB;
  const id = uuidParam(c.req.param('id'), 'id');
  const body = await jsonBody(c);
  if (body.name !== undefined && (typeof body.name !== 'string' || body.name.includes('/'))) {
    throw new ImmichError(400, 'name must be a string without slashes');
  }
  const color = colorValue(body.color);
  const existing = await requireOwnedTag(db, c.get('auth').user.id, id, 'tag.update');
  let value = existing.value;
  if (body.name) {
    const parts = value.split('/');
    parts[parts.length - 1] = body.name as string;
    value = parts.join('/');
  }
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  if (value !== existing.value) {
    // Descendants keep their own trailing segments under the new prefix.
    statements.push(
      db
        .prepare(`${DESCENDANTS} UPDATE tags SET value = ?2 || substr(value, ?3), updated_at = ?4 WHERE id IN (SELECT id FROM d) AND id <> ?1`)
        .bind(id, value, existing.value.length + 1, now),
    );
  }
  statements.push(
    db
      .prepare('UPDATE tags SET value = ?2, color = CASE WHEN ?3 THEN ?4 ELSE color END, updated_at = ?5 WHERE id = ?1')
      .bind(id, value, color === undefined ? 0 : 1, color ?? null, now),
  );
  try {
    await db.batch(statements);
  } catch (err) {
    if (String(err).includes('UNIQUE')) throw new ImmichError(400, 'A tag with that name already exists');
    throw err;
  }
  return c.json(mapTag((await db.prepare('SELECT * FROM tags WHERE id = ?1').bind(id).first<TagRow>())!));
});

tagRoutes.delete('/tags/:id', requireAuth, async (c) => {
  const id = uuidParam(c.req.param('id'), 'id');
  await requireOwnedTag(c.env.DB, c.get('auth').user.id, id, 'tag.delete');
  // Children and tag_asset rows go with the tag through ON DELETE CASCADE.
  await c.env.DB.prepare('DELETE FROM tags WHERE id = ?1').bind(id).run();
  return c.body(null, 204);
});

tagRoutes.put('/tags/:id/assets', requireAuth, async (c) => {
  const db = c.env.DB;
  const userId = c.get('auth').user.id;
  const id = uuidParam(c.req.param('id'), 'id');
  const ids = uuidArray((await jsonBody(c)).ids, 'ids');
  await requireOwnedTag(db, userId, id, 'tag.asset');
  const present = await taggedAssetIds(db, id, ids);
  const allowed = await ownedAssetIds(db, userId, ids.filter((a) => !present.has(a)), allowLocked(c));
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
  for (const part of chunks(added, CHUNK)) {
    await db.prepare('INSERT OR IGNORE INTO tag_asset (tag_id, asset_id) SELECT ?1, value FROM json_each(?2)').bind(id, json(part)).run();
  }
  return c.json(results);
});

tagRoutes.delete('/tags/:id/assets', requireAuth, async (c) => {
  const db = c.env.DB;
  const id = uuidParam(c.req.param('id'), 'id');
  const ids = uuidArray((await jsonBody(c)).ids, 'ids');
  await requireOwnedTag(db, c.get('auth').user.id, id, 'tag.asset');
  const present = await taggedAssetIds(db, id, ids);
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
  for (const part of chunks(removed, CHUNK)) {
    await db.prepare('DELETE FROM tag_asset WHERE tag_id = ?1 AND asset_id IN (SELECT value FROM json_each(?2))').bind(id, json(part)).run();
  }
  return c.json(results);
});
