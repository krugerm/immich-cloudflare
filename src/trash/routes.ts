import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { parseIds, readJson, requireAssetAccess } from '../assets/access';
import { requireAuth } from '../auth/session';
import { BATCH, MAX_PER_RUN, purgeAssets } from '../cron/purge';
import { commit, tracked } from '../db/changes';
import type { AssetRow } from '../db/rows';

export const trashRoutes = new Hono<AppEnv>();

const RESTORE_PAGE = 500;
const MAX_RESTORE_PAGES = 20;

function restoreStatement(id: string, ownerId: string, now: string) {
  return tracked('UPDATE assets SET deleted_at = NULL, updated_at = ?2, update_id = :cursor WHERE id = ?1 AND owner_id = ?3 AND deleted_at IS NOT NULL', id, now, ownerId);
}

trashRoutes.post('/trash/restore/assets', requireAuth, async (c) => {
  const body = await readJson(c);
  const ids = parseIds(body.ids);
  if (ids.length === 0) return c.json({ count: 0 });
  const assets = await requireAssetAccess(c, ids, 'delete');
  const now = new Date().toISOString();
  const trashed = [...assets.values()].filter((a) => a.deleted_at !== null);
  for (let i = 0; i < trashed.length; i += 100) {
    await commit(c.env.DB, trashed.slice(i, i + 100).map((a) => restoreStatement(a.id, a.owner_id, now)));
  }
  return c.json({ count: ids.length });
});

trashRoutes.post('/trash/restore', requireAuth, async (c) => {
  const ownerId = c.get('auth').user.id;
  const now = new Date().toISOString();
  let count = 0;
  // Restored rows leave the result set, so each page selects the next 500 trashed assets.
  for (let page = 0; page < MAX_RESTORE_PAGES; page++) {
    const { results } = await c.env.DB.prepare('SELECT id FROM assets WHERE owner_id = ?1 AND visibility <> \'locked\' AND deleted_at IS NOT NULL LIMIT ?2')
      .bind(ownerId, RESTORE_PAGE)
      .all<{ id: string }>();
    for (let i = 0; i < results.length; i += 100) {
      await commit(c.env.DB, results.slice(i, i + 100).map((r) => restoreStatement(r.id, ownerId, now)));
    }
    count += results.length;
    if (results.length < RESTORE_PAGE) break;
  }
  return c.json({ count });
});

trashRoutes.post('/trash/empty', requireAuth, async (c) => {
  const ownerId = c.get('auth').user.id;
  const now = new Date();
  let count = 0;
  // Immich queues a background job. Here the purge runs inline, capped by the subrequest budget; call again for the rest.
  while (count < MAX_PER_RUN) {
    const { results } = await c.env.DB.prepare('SELECT * FROM assets WHERE owner_id = ?1 AND visibility <> \'locked\' AND deleted_at IS NOT NULL ORDER BY deleted_at LIMIT ?2')
      .bind(ownerId, Math.min(BATCH, MAX_PER_RUN - count))
      .all<AssetRow>();
    if (results.length === 0) break;
    await purgeAssets(c.env, results, now);
    count += results.length;
  }
  return c.json({ count });
});
