import { albumItemsForPurgedAssets, type RowGuard } from '../albums/repo';
import { derivedKey } from '../container/contract';
import { commit, tracked } from '../db/changes';
import type { AssetRow } from '../db/rows';
import { deleteQueuedVectors, mlPurgeItems } from '../jobs/ml-purge'; // phase 4 G
import { memoryAssetPurgeAudit } from '../memories/repo'; // stream F
import { thumbKey } from '../process/thumbs';
import { emitAssetsDeleted } from '../realtime/emit'; // stream H
import { stackItemsForDeletedAssets } from '../stacks/repo'; // stream E

const TRASH_DAYS = 30;
export const BATCH = 25;
export const MAX_PER_RUN = 200;
const LOGIN_WINDOW_MS = 15 * 60_000;

/** Every R2 object of an asset: the original, the two thumbnails, and the media container's derived JPEGs. */
export function assetObjectKeys(a: Pick<AssetRow, 'id' | 'original_path'>): string[] {
  return [a.original_path, thumbKey(a.id, 'thumbnail'), thumbKey(a.id, 'preview'), derivedKey(a.id, 'poster'), derivedKey(a.id, 'full')];
}

/** Rows to purge for a batch: the trashed assets plus their linked live-photo videos that nothing else references. */
async function withLinkedVideos(env: Env, trashed: AssetRow[]): Promise<AssetRow[]> {
  const all = new Map(trashed.map((a) => [a.id, a]));
  const ids = [...all.keys()];
  for (const videoId of new Set(trashed.map((a) => a.live_photo_video_id).filter((v): v is string => !!v))) {
    if (all.has(videoId)) continue;
    const video = await env.DB.prepare('SELECT * FROM assets WHERE id = ?1').bind(videoId).first<AssetRow>();
    if (!video) continue;
    const { results } = await env.DB.prepare('SELECT id FROM assets WHERE live_photo_video_id = ?1').bind(videoId).all<{ id: string }>();
    if (results.every((r) => ids.includes(r.id))) all.set(videoId, video);
  }
  return [...all.values()];
}

/** Queues the asset's R2 keys inside the purge commit, only if the guard still holds when the statement runs. */
export function queueObjectDeletes(db: D1Database, a: Pick<AssetRow, 'id' | 'original_path'>, queuedAt: string, guard: RowGuard): D1PreparedStatement {
  return db
    .prepare(`INSERT OR IGNORE INTO r2_delete_queue (key, asset_id, queued_at) SELECT value, ?1, ?2 FROM json_each(?3) WHERE ${guard.sql('?4')}`)
    .bind(a.id, queuedAt, JSON.stringify(assetObjectKeys(a)), guard.value);
}

const R2_DELETE_MAX = 1000; // keys per R2 delete call

/**
 * Deletes queued R2 objects, then their queue rows. With `assetIds`, only those assets' keys (the batch just committed);
 * without, up to `pages` pages of leftovers from runs whose R2 delete failed.
 */
export async function deleteQueuedObjects(env: Env, assetIds?: string[], pages = 10): Promise<void> {
  for (let page = 0; page < pages; page++) {
    const { results } = await (assetIds
      ? env.DB.prepare('SELECT key FROM r2_delete_queue WHERE asset_id IN (SELECT value FROM json_each(?1)) LIMIT ?2').bind(JSON.stringify(assetIds), R2_DELETE_MAX)
      : env.DB.prepare('SELECT key FROM r2_delete_queue ORDER BY queued_at LIMIT ?1').bind(R2_DELETE_MAX)
    ).all<{ key: string }>();
    if (results.length === 0) return;
    const keys = results.map((r) => r.key);
    await env.MEDIA.delete(keys);
    await env.DB.prepare('DELETE FROM r2_delete_queue WHERE key IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(keys)).run();
    if (results.length < R2_DELETE_MAX) return;
  }
}

/**
 * Holds while the purge should still delete the asset: a trashed asset must still be trashed (a restore may land between
 * the purge's read and its commit), and a linked live-photo video must have no live still pointing at it.
 */
function purgeGuard(id: string, trashedIds: Set<string>): RowGuard {
  return {
    sql: (p) =>
      trashedIds.has(id)
        ? `EXISTS (SELECT 1 FROM assets WHERE id = ${p} AND deleted_at IS NOT NULL)`
        : `EXISTS (SELECT 1 FROM assets WHERE id = ${p}) AND NOT EXISTS (SELECT 1 FROM assets WHERE live_photo_video_id = ${p} AND deleted_at IS NULL)`,
    value: id,
  };
}

/**
 * Deletes rows, then originals and thumbnails. Every statement re-checks its guard, so an asset restored while the purge
 * runs keeps its row, objects, usage and links. R2 keys are queued in the same commit and deleted after it; a failed R2
 * delete is retried by the next run. Safe to run twice on the same rows.
 */
export async function purgeAssets(env: Env, trashed: AssetRow[], now: Date): Promise<void> {
  const assets = await withLinkedVideos(env, trashed);
  const trashedIds = new Set(trashed.map((a) => a.id));
  const guard = (id: string) => purgeGuard(id, trashedIds);
  const deletedAt = now.toISOString();
  // A purged motion video must not stay referenced by stills that survive (one tracked statement per still).
  const purgedIds = new Set(assets.map((a) => a.id));
  const unlinks: Array<ReturnType<typeof tracked>> = [];
  for (const v of assets) {
    if (v.type !== 'VIDEO') continue;
    const { results } = await env.DB.prepare('SELECT id, owner_id FROM assets WHERE live_photo_video_id = ?1').bind(v.id).all<{ id: string; owner_id: string }>();
    for (const still of results) {
      if (purgedIds.has(still.id)) continue;
      unlinks.push(
        tracked(
          `UPDATE assets SET live_photo_video_id = NULL, updated_at = ?4, update_id = :cursor WHERE id = ?1 AND live_photo_video_id = ?2 AND owner_id = ?3 AND ${guard(v.id).sql('?2')}`,
          still.id, v.id, still.owner_id, deletedAt,
        ),
      );
    }
  }
  const memoryAudit = await memoryAssetPurgeAudit(env.DB, assets.map((a) => a.id), guard); // stream F
  // Album rows of the purged assets, audited before the asset deletes would cascade them away.
  const albumItems = await albumItemsForPurgedAssets(env.DB, [...purgedIds], deletedAt, guard);
  // Stills come before their linked videos in `assets`, so a video's guard sees whether its still was deleted.
  await commit(env.DB, [
    ...unlinks,
    ...albumItems,
    // ids come from the assets table (UUIDs), so inlining them as literals is safe
    ...(await stackItemsForDeletedAssets(env.DB, assets.map((a) => a.id), deletedAt, trashedIds, '', (id) => guard(id).sql(`'${id}'`))),
    ...memoryAudit,
    ...(await mlPurgeItems(env, assets, deletedAt, guard)), // phase 4 G: embeddings, faces, people, vector ids
    ...assets.flatMap((a) => {
      const g = guard(a.id);
      return [
        env.DB.prepare(`UPDATE users SET usage_bytes = max(0, usage_bytes - ?1) WHERE id = ?2 AND ${g.sql('?3')}`).bind(a.file_size, a.owner_id, a.id),
        tracked(`INSERT INTO asset_audit (id, asset_id, owner_id, deleted_at) SELECT :cursor, ?1, ?2, ?3 WHERE ${g.sql('?1')}`, a.id, a.owner_id, deletedAt),
        queueObjectDeletes(env.DB, a, deletedAt, g),
        env.DB.prepare(`DELETE FROM assets WHERE id = ?1 AND ${g.sql('?1')}`).bind(a.id),
      ];
    }),
  ]);
  await emitAssetsDeleted(env, assets); // stream H
  await deleteQueuedObjects(env, assets.map((a) => a.id));
  await deleteQueuedVectors(env); // phase 4 G
}

/** Deletes login rate-limit counters whose 15-minute window has passed. */
export async function cleanupLoginFailures(db: D1Database, now = new Date()): Promise<void> {
  await db.prepare('DELETE FROM login_failures WHERE window_start < ?1').bind(new Date(now.getTime() - LOGIN_WINDOW_MS).toISOString()).run();
}

/** The only code path that deletes originals of assets that have rows. */
export async function purgeTrash(
  env: Env,
  now = new Date(),
  opts: { maxPerRun?: number; batch?: number } = {},
): Promise<number> {
  const maxPerRun = opts.maxPerRun ?? MAX_PER_RUN;
  const batch = opts.batch ?? BATCH;
  const cutoff = new Date(now.getTime() - TRASH_DAYS * 86_400_000).toISOString();
  await deleteQueuedObjects(env); // leftovers from runs whose R2 delete failed
  await deleteQueuedVectors(env); // phase 4 G: same for Vectorize
  let purged = 0;
  while (purged < maxPerRun) {
    const { results } = await env.DB.prepare(
      'SELECT * FROM assets WHERE deleted_at IS NOT NULL AND deleted_at < ?1 ORDER BY deleted_at LIMIT ?2',
    )
      .bind(cutoff, Math.min(batch, maxPerRun - purged))
      .all<AssetRow>();
    if (results.length === 0) break;
    await purgeAssets(env, results, now);
    purged += results.length;
  }
  return purged;
}
