/**
 * Asset access rules, ported from Immich `utils/access.ts` (AssetRead / AssetShare).
 * Each rule is one SQL condition over the candidate asset `a`, with `?1` bound to the caller's user id.
 * To grant non-owner access another way, add one line to READ_RULES.
 */

/**
 * Non-owner read rules (Immich checkAlbumAccess, checkPartnerAccess). The locked rule is applied once, in
 * canReadAsset: a locked asset is never readable through any of these.
 */
const READ_RULES = [
  // member (any role) of an album that holds the asset, or holds the live-photo still whose video it is; trashed and locked album assets do not count
  "EXISTS (SELECT 1 FROM album_assets aa JOIN album_users au ON au.album_id = aa.album_id JOIN assets s ON s.id = aa.asset_id AND s.deleted_at IS NULL AND s.visibility != 'locked' WHERE au.user_id = ?1 AND (s.id = a.id OR s.live_photo_video_id = a.id))",
  // stream D: the owner (not deleted) shares with the caller; the asset is not trashed and is timeline or hidden
  "(a.deleted_at IS NULL AND a.visibility IN ('timeline', 'hidden') AND EXISTS (SELECT 1 FROM partners p JOIN users u ON u.id = p.shared_by_id AND u.deleted_at IS NULL WHERE p.shared_with_id = ?1 AND p.shared_by_id = a.owner_id))",
];

/**
 * Owner (Immich checkOwnerAccess with hasElevatedPermission: locked only from an elevated session), or any READ_RULE
 * for a non-locked asset. Locked assets are never readable through albums, partners or shared links.
 */
const READ_SQL = `((a.owner_id = ?1 AND (a.visibility != 'locked' OR ?3 = 1)) OR (a.visibility != 'locked' AND (${READ_RULES.join(' OR ')})))`;

/** Assets the caller may put into albums and shared links (Immich AssetShare = checkOwnerAccess(..., false): never locked). */
const SHARE_RULES = ["(a.owner_id = ?1 AND a.visibility != 'locked')"];

/** The single asset read check (Immich AssetRead for a user). `elevated`: the session is PIN-elevated. */
export async function canReadAsset(db: D1Database, userId: string, assetId: string, opts: { elevated: boolean } = { elevated: false }): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS ok FROM assets a WHERE a.id = ?2 AND ${READ_SQL}`)
    .bind(userId, assetId, opts.elevated ? 1 : 0)
    .first();
  return row !== null;
}

/** The subset of `assetIds` the caller may share. One query regardless of the list length. */
export async function shareableAssetIds(db: D1Database, userId: string, assetIds: string[]): Promise<Set<string>> {
  if (assetIds.length === 0) return new Set();
  const { results } = await db
    .prepare(`SELECT a.id FROM assets a WHERE a.id IN (SELECT value FROM json_each(?2)) AND (${SHARE_RULES.join(' OR ')})`)
    .bind(userId, JSON.stringify(assetIds))
    .all<{ id: string }>();
  return new Set(results.map((r) => r.id));
}

/**
 * Immich AssetAccess.checkSharedLinkAccess: the link's own assets or its album's assets (not trashed), and their
 * live-photo videos. Locked assets are refused even if a link row points at them (second guard behind AssetShare).
 */
export async function sharedLinkCanReadAsset(db: D1Database, sharedLinkId: string, assetId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS ok FROM shared_links l
       JOIN assets s ON s.deleted_at IS NULL AND s.visibility != 'locked' AND (
         s.id IN (SELECT asset_id FROM shared_link_assets WHERE shared_link_id = l.id)
         OR s.id IN (SELECT asset_id FROM album_assets WHERE album_id = l.album_id))
       WHERE l.id = ?1 AND (s.id = ?2 OR s.live_photo_video_id = ?2)
         AND NOT EXISTS (SELECT 1 FROM assets t WHERE t.id = ?2 AND t.visibility = 'locked')
       LIMIT 1`,
    )
    .bind(sharedLinkId, assetId)
    .first();
  return row !== null;
}
