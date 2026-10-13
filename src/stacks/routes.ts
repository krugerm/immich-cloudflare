import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { requireAuth } from '../auth/session';
import { commit, tracked, type Tracked } from '../db/changes';
import { ImmichError } from '../http/errors';
import { chunks, jsonBody, json, uuidArray, uuidParam } from '../tags/util';
import { clearAssetStack, deleteStackItems, loadStacks, mapStacks, memberIds, setAssetStack, type StackRow } from './repo';

export const MAX_CREATE = 200;
export const MAX_BULK_DELETE = 100;
/** Tracked items per commit: each is two statements, and a Worker invocation may run 1000 D1 queries. */
const ITEMS_PER_COMMIT = 200;

export const stackRoutes = new Hono<AppEnv>();

async function requireOwnedStacks(db: D1Database, userId: string, ids: string[], permission: string): Promise<StackRow[]> {
  const unique = [...new Set(ids)];
  const rows: StackRow[] = [];
  for (const part of chunks(unique, 500)) {
    const { results } = await db
      .prepare('SELECT * FROM stacks WHERE owner_id = ?1 AND id IN (SELECT value FROM json_each(?2))')
      .bind(userId, json(part))
      .all<StackRow>();
    rows.push(...results);
  }
  if (rows.length !== unique.length) throw new ImmichError(400, `Not found or no ${permission} access`);
  return rows;
}

async function requireOwnedAssets(db: D1Database, userId: string, ids: string[]): Promise<void> {
  const unique = [...new Set(ids)];
  let found = 0;
  for (const part of chunks(unique, 500)) {
    const row = await db
      .prepare('SELECT count(*) AS n FROM assets WHERE owner_id = ?1 AND id IN (SELECT value FROM json_each(?2))')
      .bind(userId, json(part))
      .first<{ n: number }>();
    found += row!.n;
  }
  if (found !== unique.length) throw new ImmichError(400, 'Not found or no asset.update access');
}

/** Deletes stacks and releases every member (trashed ones too), one asset per statement so each gets an AssetV2 line. */
async function removeStacks(db: D1Database, stackIds: string[], now: string): Promise<void> {
  const members = await memberIds(db, stackIds);
  // Members first, stacks last: a failure part way leaves the stack in place so that a retry finishes the job.
  for (const part of chunks(members, ITEMS_PER_COMMIT)) await commit(db, part.map((m) => clearAssetStack(m.id, now)));
  for (const part of chunks(stackIds, ITEMS_PER_COMMIT / 2)) await commit(db, part.flatMap((id) => deleteStackItems(db, id, now)));
}

stackRoutes.get('/stacks', requireAuth, async (c) => {
  const primary = c.req.query('primaryAssetId');
  if (primary !== undefined) uuidParam(primary, 'primaryAssetId');
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM stacks WHERE owner_id = ?1 AND (?2 IS NULL OR primary_asset_id = ?2) ORDER BY created_at, id`,
  )
    .bind(c.get('auth').user.id, primary ?? null)
    .all<StackRow>();
  return c.json(await mapStacks(c.env.DB, await loadStacks(c.env.DB, results), false));
});

stackRoutes.post('/stacks', requireAuth, async (c) => {
  const db = c.env.DB;
  const userId = c.get('auth').user.id;
  const assetIds = uuidArray((await jsonBody(c)).assetIds, 'assetIds');
  if (assetIds.length < 2) throw new ImmichError(400, 'assetIds must contain at least 2 items');
  if (assetIds.length > MAX_CREATE) throw new ImmichError(400, `assetIds must contain at most ${MAX_CREATE} items`);
  await requireOwnedAssets(db, userId, assetIds);

  // Stacks whose primary is among the ids are merged into the new one.
  const { results: old } = await db
    .prepare('SELECT id FROM stacks WHERE owner_id = ?1 AND primary_asset_id IN (SELECT value FROM json_each(?2))')
    .bind(userId, json(assetIds))
    .all<{ id: string }>();
  const oldIds = old.map((o) => o.id);
  const oldMembers = await memberIds(db, oldIds);
  const unique = new Set(assetIds);
  for (const m of oldMembers) if (m.deleted_at === null) unique.add(m.id);
  // One atomic batch: new stack + joined members + released members + dissolved stacks, two statements per tracked item.
  if (unique.size + oldIds.length * 2 + oldMembers.length + 1 > 400) throw new ImmichError(400, 'Too many assets in the resulting stack');

  const now = new Date().toISOString();
  const stackId = crypto.randomUUID();
  const items: Array<Tracked | D1PreparedStatement> = [];
  for (const id of oldIds) items.push(...deleteStackItems(db, id, now));
  // Members of dissolved stacks that do not join the new one (trashed) are released.
  for (const m of oldMembers) if (!unique.has(m.id)) items.push(clearAssetStack(m.id, now));
  items.push(
    tracked(
      'INSERT INTO stacks (id, owner_id, primary_asset_id, created_at, updated_at, update_id) VALUES (?1, ?2, ?3, ?4, ?4, :cursor)',
      stackId,
      userId,
      assetIds[0],
      now,
    ),
  );
  for (const id of unique) items.push(setAssetStack(id, stackId, now));
  await commit(db, items);

  const stack = (await db.prepare('SELECT * FROM stacks WHERE id = ?1').bind(stackId).first<StackRow>())!;
  return c.json((await mapStacks(db, await loadStacks(db, [stack]), false))[0], 201);
});

stackRoutes.delete('/stacks', requireAuth, async (c) => {
  const ids = uuidArray((await jsonBody(c)).ids, 'ids');
  if (ids.length > MAX_BULK_DELETE) throw new ImmichError(400, `ids must contain at most ${MAX_BULK_DELETE} items`);
  const stacks = await requireOwnedStacks(c.env.DB, c.get('auth').user.id, ids, 'stack.delete');
  await removeStacks(c.env.DB, stacks.map((s) => s.id), new Date().toISOString());
  return c.body(null, 204);
});

stackRoutes.get('/stacks/:id', requireAuth, async (c) => {
  const id = uuidParam(c.req.param('id'), 'id');
  const [stack] = await requireOwnedStacks(c.env.DB, c.get('auth').user.id, [id], 'stack.read');
  return c.json((await mapStacks(c.env.DB, await loadStacks(c.env.DB, [stack]), true))[0]);
});

stackRoutes.put('/stacks/:id', requireAuth, async (c) => {
  const db = c.env.DB;
  const id = uuidParam(c.req.param('id'), 'id');
  const body = await jsonBody(c);
  if (body.primaryAssetId === null) delete body.primaryAssetId;
  if (body.primaryAssetId !== undefined) uuidParam(body.primaryAssetId as string, 'primaryAssetId');
  const [stack] = await requireOwnedStacks(db, c.get('auth').user.id, [id], 'stack.update');
  const [loaded] = await loadStacks(db, [stack]);
  if (body.primaryAssetId && loaded.assets.every((a) => a.id !== body.primaryAssetId)) {
    throw new ImmichError(400, 'Primary asset must be in the stack');
  }
  await commit(db, [
    tracked(
      'UPDATE stacks SET primary_asset_id = COALESCE(?2, primary_asset_id), updated_at = ?3, update_id = :cursor WHERE id = ?1',
      id,
      (body.primaryAssetId as string | undefined) ?? null,
      new Date().toISOString(),
    ),
  ]);
  const updated = (await db.prepare('SELECT * FROM stacks WHERE id = ?1').bind(id).first<StackRow>())!;
  return c.json((await mapStacks(db, await loadStacks(db, [updated]), true))[0]);
});

stackRoutes.delete('/stacks/:id', requireAuth, async (c) => {
  const id = uuidParam(c.req.param('id'), 'id');
  await requireOwnedStacks(c.env.DB, c.get('auth').user.id, [id], 'stack.delete');
  await removeStacks(c.env.DB, [id], new Date().toISOString());
  return c.body(null, 204);
});

stackRoutes.delete('/stacks/:id/assets/:assetId', requireAuth, async (c) => {
  const db = c.env.DB;
  const id = uuidParam(c.req.param('id'), 'id');
  const assetId = uuidParam(c.req.param('assetId'), 'assetId');
  const [stack] = await requireOwnedStacks(db, c.get('auth').user.id, [id], 'stack.update');
  const asset = await db.prepare('SELECT stack_id FROM assets WHERE id = ?1').bind(assetId).first<{ stack_id: string | null }>();
  if (asset?.stack_id !== stack.id) throw new ImmichError(400, 'Asset not in stack');
  if (stack.primary_asset_id === assetId) throw new ImmichError(400, "Cannot remove stack's primary asset");
  await commit(db, [clearAssetStack(assetId, new Date().toISOString())]);
  return c.body(null, 204);
});
