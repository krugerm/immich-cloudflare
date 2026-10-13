import { albumItemsForPurgedAssets, deleteAlbumStatements, removeAlbumUser } from '../albums/repo';
import { deleteQueuedVectors, mlPurgeItems } from '../jobs/ml-purge'; // phase 4 G
import { commit, tracked } from '../db/changes';
import type { AssetRow, UserRow } from '../db/rows';
import { disconnectSessions, disconnectUser } from '../realtime/emit';
import { stackItemsForDeletedAssets } from '../stacks/repo';
import { deleteQueuedObjects, queueObjectDeletes } from './purge';

// stream A: hard deletion of users (Immich's UserDeleteCheck + UserDelete jobs).

export const USER_DELETE_DELAY_DAYS = 7; // Immich's default config.user.deleteDelay
const ASSET_BATCH = 25;
export const MAX_ASSETS_PER_RUN = 200;

async function r2Keys(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

/** Users due for removal: `force`-deleted ones at once, the others once the delay has passed. */
export async function usersDueForRemoval(db: D1Database, now: Date): Promise<UserRow[]> {
  const cutoff = new Date(now.getTime() - USER_DELETE_DELAY_DAYS * 86_400_000).toISOString();
  const { results } = await db
    .prepare(`SELECT * FROM users WHERE deleted_at IS NOT NULL AND (status = 'removing' OR deleted_at < ?1) ORDER BY deleted_at`)
    .bind(cutoff)
    .all<UserRow>();
  return results;
}

/**
 * Deletes up to `budget` of the user's assets (R2 objects, rows, asset_audit), then, once none are left, the profile image
 * and the user row with its user_audit entry (UserDeleteV1). Sessions, checkpoints and API keys go by cascade.
 * Returns the number of assets deleted and whether the user is gone. Every statement re-checks that the user is still
 * deleted, so a restore that races the purge keeps the account.
 */
export async function purgeUser(env: Env, userId: string, now: Date, budget: number): Promise<{ assets: number; done: boolean }> {
  let deleted = 0;
  const stillDeleted = 'EXISTS (SELECT 1 FROM users WHERE id = ?2 AND deleted_at IS NOT NULL)';
  while (deleted < budget) {
    const { results } = await env.DB.prepare(`SELECT * FROM assets WHERE owner_id = ?1 AND ${stillDeleted.replace('?2', '?1')} LIMIT ?2`)
      .bind(userId, Math.min(ASSET_BATCH, budget - deleted))
      .all<AssetRow>();
    if (results.length === 0) break;
    const deletedAt = now.toISOString();
    const userGuard = { sql: (p: string) => `EXISTS (SELECT 1 FROM users WHERE id = ${p} AND deleted_at IS NOT NULL)`, value: userId };
    const albumItems = await albumItemsForPurgedAssets(env.DB, results.map((a) => a.id), deletedAt, () => userGuard);
    // stream E: stacks whose primary goes get a new primary or are dissolved with a stack_audit row
    const stackItems = await stackItemsForDeletedAssets(
      env.DB,
      results.map((a) => a.id),
      deletedAt,
      new Set(),
      `EXISTS (SELECT 1 FROM users WHERE id = '${userId}' AND deleted_at IS NOT NULL)`,
    );
    await commit(env.DB, [
      // album rows first: the asset deletes below would cascade them away without audit
      ...albumItems,
      ...stackItems,
      ...(await mlPurgeItems(env, results, deletedAt, () => userGuard)), // phase 4 G
      ...results.flatMap((a) => [
        tracked(
          `INSERT INTO asset_audit (id, asset_id, owner_id, deleted_at) SELECT :cursor, ?1, ?2, ?3
           WHERE EXISTS (SELECT 1 FROM assets WHERE id = ?1) AND EXISTS (SELECT 1 FROM users WHERE id = ?2 AND deleted_at IS NOT NULL)`,
          a.id,
          userId,
          deletedAt,
        ),
        // R2 keys are queued in this commit and deleted after it, so a restored user keeps their files
        queueObjectDeletes(env.DB, a, deletedAt, userGuard),
        env.DB.prepare(`DELETE FROM assets WHERE id = ?1 AND ${stillDeleted}`).bind(a.id, userId),
      ]),
    ]);
    await deleteQueuedObjects(env, results.map((a) => a.id));
    await deleteQueuedVectors(env); // phase 4 G
    deleted += results.length;
  }
  if (deleted >= budget) return { assets: deleted, done: false };
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?1 AND deleted_at IS NOT NULL').bind(userId).first<UserRow>();
  if (!user) return { assets: deleted, done: false };
  if (await env.DB.prepare('SELECT 1 FROM assets WHERE owner_id = ?1 LIMIT 1').bind(userId).first()) return { assets: deleted, done: false };
  // stream D: partner rows on either side (no cascade), each with a PartnerDeleteV1 audit row, one row per
  // statement. A partner row created after this read makes the user DELETE fail its foreign key, which rolls the
  // whole batch back; the next run retries.
  const { results: partnerRows } = await env.DB.prepare('SELECT shared_by_id, shared_with_id FROM partners WHERE shared_by_id = ?1 OR shared_with_id = ?1')
    .bind(userId)
    .all<{ shared_by_id: string; shared_with_id: string }>();
  const deletedAt = now.toISOString();
  // stream C: Immich AlbumRepository.deleteAll for the user's own albums (each member gets AlbumDeleteV1, as
  // DELETE /albums/:id), and the album_users delete trigger for albums of others (AlbumUserDeleteV1 to the rest).
  const { results: memberships } = await env.DB.prepare(
    `SELECT au.album_id, au.role, (SELECT json_group_array(m.user_id) FROM album_users m WHERE m.album_id = au.album_id) AS members
     FROM album_users au WHERE au.user_id = ?1`,
  )
    .bind(userId)
    .all<{ album_id: string; role: string; members: string }>();
  const userGuard = { sql: (p: string) => `EXISTS (SELECT 1 FROM users WHERE id = ${p} AND deleted_at IS NOT NULL)`, value: userId };
  const albumItems = memberships.flatMap((m) =>
    m.role === 'owner'
      ? deleteAlbumStatements(env.DB, m.album_id, JSON.parse(m.members) as string[], deletedAt, userGuard)
      : removeAlbumUser(env.DB, m.album_id, userId, deletedAt, userGuard),
  );
  // phase 4 G: people without any face survive the asset purge; their rows go with the user (cascade), so remove the
  // cluster groups and thumbnails here
  const { results: peopleRows } = await env.DB.prepare('SELECT person_group_id FROM people WHERE owner_id = ?1').bind(userId).all<{ person_group_id: string }>();
  const results = await commit(env.DB, [
    ...albumItems,
    env.DB.prepare(`DELETE FROM person_groups WHERE cluster_group_id = ?1 AND ${stillDeleted.replace('?2', '?1')}`).bind(userId),
    ...partnerRows.flatMap((p) => [
      tracked(
        `INSERT INTO partner_audit (id, shared_by_id, shared_with_id, deleted_at) SELECT :cursor, ?1, ?2, ?3
         WHERE EXISTS (SELECT 1 FROM partners WHERE shared_by_id = ?1 AND shared_with_id = ?2)
           AND EXISTS (SELECT 1 FROM users WHERE id = ?4 AND deleted_at IS NOT NULL)`,
        p.shared_by_id,
        p.shared_with_id,
        deletedAt,
        userId,
      ),
      env.DB.prepare(`DELETE FROM partners WHERE shared_by_id = ?1 AND shared_with_id = ?2 AND ${stillDeleted.replace('?2', '?3')}`).bind(
        p.shared_by_id,
        p.shared_with_id,
        userId,
      ),
    ]),
    // notifications would cascade with the user row; deleted explicitly so the purge does not rely on it
    env.DB.prepare(`DELETE FROM notifications WHERE user_id = ?1 AND ${stillDeleted.replace('?2', '?1')}`).bind(userId),
    tracked(
      `INSERT INTO user_audit (id, user_id, deleted_at) SELECT :cursor, ?1, ?2
       WHERE EXISTS (SELECT 1 FROM users WHERE id = ?1 AND deleted_at IS NOT NULL)`,
      userId,
      now.toISOString(),
    ),
    env.DB.prepare('DELETE FROM users WHERE id = ?1 AND deleted_at IS NOT NULL').bind(userId),
  ]);
  const gone = (results[results.length - 1]?.meta.changes ?? 0) > 0;
  if (gone) {
    // stream H: the cascade above removed the user's sessions; close their sockets (disconnectUser never throws)
    await disconnectUser(env, userId).catch((err) => console.error('realtime disconnect failed', userId, err));
    const profileKeys = await r2Keys(env.MEDIA, `profile/${userId}.`);
    if (profileKeys.length) await env.MEDIA.delete(profileKeys);
    // phase 4 G: in chunks of 1000 (the R2 delete limit)
    const thumbs = peopleRows.map((p) => `people/${p.person_group_id}.jpeg`);
    for (let i = 0; i < thumbs.length; i += 1000) await env.MEDIA.delete(thumbs.slice(i, i + 1000));
  }
  return { assets: deleted, done: gone };
}

export async function purgeDeletedUsers(env: Env, now = new Date(), maxAssets = MAX_ASSETS_PER_RUN): Promise<number> {
  let budget = maxAssets;
  let removed = 0;
  for (const u of await usersDueForRemoval(env.DB, now)) {
    if (budget <= 0) break;
    try {
      const r = await purgeUser(env, u.id, now, budget);
      budget -= r.assets;
      if (r.done) removed++;
    } catch (err) {
      // one failing user (e.g. a row another table still references) must not block the others; retried next run
      console.error('user purge failed', u.id, err);
    }
  }
  return removed;
}

/**
 * Deletes sessions whose `expires_at` has passed (child sessions from POST /sessions); checkpoints and descendant
 * sessions cascade. As deleteSessionTree: one batch reads the ids (descendants included) and deletes them, then the
 * sockets of exactly those sessions are closed. Returns the number of expired sessions deleted.
 */
export async function purgeExpiredSessions(env: Env, now = new Date()): Promise<number> {
  const tree = `WITH RECURSIVE d(id, user_id) AS (SELECT id, user_id FROM sessions WHERE expires_at IS NOT NULL AND expires_at < ?1
                  UNION SELECT s.id, s.user_id FROM sessions s JOIN d ON s.parent_id = d.id) SELECT id, user_id FROM d`;
  const [read, del] = await env.DB.batch([
    env.DB.prepare(tree).bind(now.toISOString()),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at IS NOT NULL AND expires_at < ?1').bind(now.toISOString()),
  ]);
  const byUser = new Map<string, string[]>();
  for (const s of (read.results ?? []) as Array<{ id: string; user_id: string }>) byUser.set(s.user_id, [...(byUser.get(s.user_id) ?? []), s.id]);
  await Promise.all([...byUser].map(([userId, ids]) => disconnectSessions(env, userId, ids)));
  return del.meta.changes ?? 0;
}
