import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { requireAuth } from '../auth/session';
import { commit, tracked, type Tracked } from '../db/changes';
import type { ExifRow } from '../db/rows';
import { ImmichError } from '../http/errors';
import { BATCH, MAX_PER_RUN, purgeAssets } from '../cron/purge';
import { allowLocked, isUuid, parseIds, readJson, requireAssetAccess } from './access';
import { mapAssetResponse } from './map';
import { applyPatch, badRequest, parsePatch } from './update';

export const assetManageRoutes = new Hono<AppEnv>();

const JOB_NAMES = ['refresh-faces', 'refresh-metadata', 'regenerate-thumbnail', 'transcode-video'];

async function commitAll(db: D1Database, items: Tracked[], per = 100): Promise<void> {
  for (let i = 0; i < items.length; i += per) await commit(db, items.slice(i, i + per));
}

// ---- update ----

assetManageRoutes.put('/assets/copy', requireAuth, async (c) => {
  const body = await readJson(c);
  if (!isUuid(body.sourceId) || !isUuid(body.targetId)) throw badRequest('sourceId and targetId must be UUIDs');
  for (const flag of ['albums', 'sidecar', 'sharedLinks', 'stack', 'favorite']) {
    if (body[flag] !== undefined && typeof body[flag] !== 'boolean') throw badRequest(`${flag} must be a boolean`);
  }
  if (body.sourceId === body.targetId) throw badRequest('Source and target id must be distinct');
  const assets = await requireAssetAccess(c, [body.sourceId, body.targetId], 'copy');
  // Albums, shared links and stacks do not exist yet and sidecar files are not stored; only favorite is copied.
  if (body.favorite !== false) {
    const source = assets.get(body.sourceId)!;
    const target = assets.get(body.targetId)!;
    if (source.is_favorite !== target.is_favorite) {
      await commit(c.env.DB, [
        tracked('UPDATE assets SET is_favorite = ?2, updated_at = ?3, update_id = :cursor WHERE id = ?1 AND owner_id = ?4', target.id, source.is_favorite, new Date().toISOString(), target.owner_id),
      ]);
    }
  }
  return c.body(null, 204);
});

assetManageRoutes.put('/assets', requireAuth, async (c) => {
  const body = await readJson(c);
  const ids = parseIds(body.ids);
  const patch = parsePatch(body, true);
  const assets = await requireAssetAccess(c, ids, 'update');
  await applyPatch(c.env, assets, patch, allowLocked(c));
  return c.body(null, 204);
});

// ---- delete ----

assetManageRoutes.delete('/assets', requireAuth, async (c) => {
  const body = await readJson(c);
  const ids = parseIds(body.ids);
  if (body.force !== undefined && typeof body.force !== 'boolean') throw badRequest('force must be a boolean');
  const assets = await requireAssetAccess(c, ids, 'delete');
  const now = new Date();
  const stamp = now.toISOString();
  const toTrash = [...assets.values()].filter((a) => a.deleted_at === null);
  await commitAll(
    c.env.DB,
    toTrash.map((a) => tracked('UPDATE assets SET deleted_at = ?2, updated_at = ?2, update_id = :cursor WHERE id = ?1 AND owner_id = ?3 AND deleted_at IS NULL', a.id, stamp, a.owner_id)),
  );
  if (body.force === true) {
    // Immich queues the deletion; here it runs inline, capped by the Worker's subrequest budget. The rest stays trashed.
    const doomed = [...assets.values()].map((a) => (a.deleted_at === null ? { ...a, deleted_at: stamp } : a)).slice(0, MAX_PER_RUN);
    for (let i = 0; i < doomed.length; i += BATCH) await purgeAssets(c.env, doomed.slice(i, i + BATCH), now);
  }
  return c.body(null, 204);
});

// ---- jobs ----

assetManageRoutes.post('/assets/jobs', requireAuth, async (c) => {
  const body = await readJson(c);
  const ids = parseIds(body.assetIds, 'assetIds', 1000);
  if (typeof body.name !== 'string' || !JOB_NAMES.includes(body.name)) throw badRequest(`name must be one of ${JOB_NAMES.join(', ')}`);
  const assets = await requireAssetAccess(c, ids, 'update');
  if (body.name === 'refresh-metadata' || body.name === 'regenerate-thumbnail') {
    // The process consumer skips ready assets, so reset to pending first; refresh-faces and transcode-video are phase 3/4 work.
    // Per chunk of 100: enqueue first (with a short delay so the reset below lands before delivery), then reset.
    // A failed send returns 500 before that chunk is reset, so no asset is left pending without a message.
    const stamp = new Date().toISOString();
    const all = [...assets.values()];
    for (let i = 0; i < all.length; i += 100) {
      const chunk = all.slice(i, i + 100);
      try {
        await c.env.PROCESS_QUEUE.sendBatch(chunk.map((a) => ({ body: { assetId: a.id }, delaySeconds: 5 })));
      } catch (err) {
        console.error('failed to enqueue asset jobs', err);
        throw new ImmichError(500, 'Failed to queue jobs');
      }
      await commit(
        c.env.DB,
        chunk.map((a) => tracked(`UPDATE assets SET status = 'pending', error = NULL, updated_at = ?2, update_id = :cursor WHERE id = ?1 AND owner_id = ?3`, a.id, stamp, a.owner_id)),
      );
    }
  }
  return c.body(null, 204);
});

// ---- metadata ----

interface MetaRow {
  asset_id: string;
  key: string;
  value: string;
  updated_at: string;
}

const MAX_VALUE_BYTES = 65_536;

function parseItem(item: unknown, withAsset: boolean): { assetId?: string; key: string; value?: Record<string, unknown> } {
  const o = item as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || typeof o.key !== 'string' || o.key.length === 0 || o.key.length > 256) throw badRequest('Invalid metadata item');
  if (withAsset && !isUuid(o.assetId)) throw badRequest('Invalid metadata item assetId');
  return { assetId: o.assetId as string | undefined, key: o.key, value: o.value as Record<string, unknown> | undefined };
}

function parseUpsertItem(item: unknown, withAsset: boolean) {
  const parsed = parseItem(item, withAsset);
  const v = parsed.value;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw badRequest('Metadata value must be an object');
  if (new TextEncoder().encode(JSON.stringify(v)).length > MAX_VALUE_BYTES) throw badRequest('Metadata value is too large');
  return { assetId: parsed.assetId, key: parsed.key, value: v };
}

function upsertStatement(assetId: string, ownerId: string, key: string, value: unknown, now: string): Tracked {
  return tracked(
    `INSERT INTO asset_metadata (asset_id, key, owner_id, value, created_at, updated_at, update_id)
     SELECT ?1, ?2, ?3, ?4, ?5, ?5, :cursor WHERE EXISTS (SELECT 1 FROM assets WHERE id = ?1 AND owner_id = ?3)
     ON CONFLICT (asset_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, update_id = excluded.update_id`,
    assetId, key, ownerId, JSON.stringify(value), now,
  );
}

function deleteStatements(db: D1Database, assetId: string, ownerId: string, key: string, now: string): Array<Tracked | D1PreparedStatement> {
  return [
    tracked(
      `INSERT INTO asset_metadata_audit (id, asset_id, key, owner_id, deleted_at)
       SELECT :cursor, ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM asset_metadata WHERE asset_id = ?1 AND key = ?2 AND owner_id = ?3)`,
      assetId, key, ownerId, now,
    ),
    db.prepare('DELETE FROM asset_metadata WHERE asset_id = ?1 AND key = ?2 AND owner_id = ?3').bind(assetId, key, ownerId),
  ];
}

const dto = (r: MetaRow) => ({ key: r.key, value: JSON.parse(r.value), updatedAt: r.updated_at });

assetManageRoutes.put('/assets/metadata', requireAuth, async (c) => {
  const body = await readJson(c);
  if (!Array.isArray(body.items) || body.items.length > 1000) throw badRequest('items must be an array');
  const items = body.items.map((i) => parseUpsertItem(i, true));
  const seen = new Set<string>();
  for (const i of items) {
    const k = `(${i.assetId}, ${i.key})`;
    if (seen.has(k)) throw badRequest(`Duplicate items are not allowed: "${k}"`);
    seen.add(k);
  }
  const assets = await requireAssetAccess(c, items.map((i) => i.assetId!), 'update');
  const now = new Date().toISOString();
  await commitAll(c.env.DB, items.map((i) => upsertStatement(i.assetId!, assets.get(i.assetId!)!.owner_id, i.key, i.value, now)));
  return c.json(items.map((i) => ({ assetId: i.assetId, key: i.key, value: i.value, updatedAt: now })));
});

assetManageRoutes.delete('/assets/metadata', requireAuth, async (c) => {
  const body = await readJson(c);
  if (!Array.isArray(body.items) || body.items.length > 1000) throw badRequest('items must be an array');
  const items = body.items.map((i) => parseItem(i, true));
  const assets = await requireAssetAccess(c, items.map((i) => i.assetId!), 'update');
  const now = new Date().toISOString();
  for (let n = 0; n < items.length; n += 50) {
    await commit(c.env.DB, items.slice(n, n + 50).flatMap((i) => deleteStatements(c.env.DB, i.assetId!, assets.get(i.assetId!)!.owner_id, i.key, now)));
  }
  return c.body(null, 204);
});

assetManageRoutes.get('/assets/:id/metadata', requireAuth, async (c) => {
  const id = c.req.param('id');
  if (!isUuid(id)) throw badRequest('id must be a UUID');
  await requireAssetAccess(c, [id], 'read');
  const { results } = await c.env.DB.prepare('SELECT * FROM asset_metadata WHERE asset_id = ?1 ORDER BY key').bind(id).all<MetaRow>();
  return c.json(results.map(dto));
});

assetManageRoutes.put('/assets/:id/metadata', requireAuth, async (c) => {
  const id = c.req.param('id');
  if (!isUuid(id)) throw badRequest('id must be a UUID');
  const body = await readJson(c);
  if (!Array.isArray(body.items) || body.items.length > 1000) throw badRequest('items must be an array');
  const items = body.items.map((i) => parseUpsertItem({ ...(i as object), assetId: id }, true));
  const keys = new Set<string>();
  for (const i of items) {
    if (keys.has(i.key)) throw badRequest(`Duplicate items are not allowed: "${i.key}"`);
    keys.add(i.key);
  }
  const assets = await requireAssetAccess(c, [id], 'update');
  const now = new Date().toISOString();
  await commitAll(c.env.DB, items.map((i) => upsertStatement(id, assets.get(id)!.owner_id, i.key, i.value, now)));
  return c.json(items.map((i) => ({ key: i.key, value: i.value, updatedAt: now })));
});

assetManageRoutes.get('/assets/:id/metadata/:key', requireAuth, async (c) => {
  const id = c.req.param('id');
  if (!isUuid(id)) throw badRequest('id must be a UUID');
  await requireAssetAccess(c, [id], 'read');
  const key = c.req.param('key');
  const row = await c.env.DB.prepare('SELECT * FROM asset_metadata WHERE asset_id = ?1 AND key = ?2').bind(id, key).first<MetaRow>();
  if (!row) throw badRequest(`Metadata with key "${key}" not found for asset with id "${id}"`);
  return c.json(dto(row));
});

assetManageRoutes.delete('/assets/:id/metadata/:key', requireAuth, async (c) => {
  const id = c.req.param('id');
  if (!isUuid(id)) throw badRequest('id must be a UUID');
  const assets = await requireAssetAccess(c, [id], 'update');
  await commit(c.env.DB, deleteStatements(c.env.DB, id, assets.get(id)!.owner_id, c.req.param('key'), new Date().toISOString()));
  return c.body(null, 204);
});

// ---- edits ----
// Edited renditions need image processing the phase 1 pipeline lacks, so every asset has an empty edit list.

assetManageRoutes.get('/assets/:id/edits', requireAuth, async (c) => {
  const id = c.req.param('id');
  if (!isUuid(id)) throw badRequest('id must be a UUID');
  await requireAssetAccess(c, [id], 'read');
  return c.json({ assetId: id, edits: [] });
});

assetManageRoutes.delete('/assets/:id/edits', requireAuth, async (c) => {
  const id = c.req.param('id');
  if (!isUuid(id)) throw badRequest('id must be a UUID');
  await requireAssetAccess(c, [id], 'update');
  return c.body(null, 204);
});

assetManageRoutes.put('/assets/:id/edits', requireAuth, async (c) => {
  const id = c.req.param('id');
  if (!isUuid(id)) throw badRequest('id must be a UUID');
  await requireAssetAccess(c, [id], 'update');
  throw new ImmichError(400, 'Asset editing is not supported by this server');
});

// Registered last so the static PUT /assets/copy and /assets/metadata paths win over :id.
assetManageRoutes.put('/assets/:id', requireAuth, async (c) => {
  const id = c.req.param('id');
  if (!isUuid(id)) throw badRequest('id must be a UUID');
  const body = await readJson(c);
  const patch = parsePatch(body, false);
  const assets = await requireAssetAccess(c, [id], 'update');
  await applyPatch(c.env, assets, patch, allowLocked(c));
  const a = await c.env.DB.prepare('SELECT * FROM assets WHERE id = ?1').bind(id).first<any>();
  const e = await c.env.DB.prepare('SELECT * FROM asset_exif WHERE asset_id = ?1').bind(id).first<ExifRow>();
  return c.json(mapAssetResponse(a, e));
});
