/**
 * Immich AssetAccess.checkPartnerAccess: the asset's owner shares with `userId`, the owner is not deleted,
 * and the asset is not trashed and has visibility `timeline` or `hidden`.
 */
export async function partnerCanReadAsset(db: D1Database, userId: string, assetId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS ok FROM partners p
       JOIN users u ON u.id = p.shared_by_id AND u.deleted_at IS NULL
       JOIN assets a ON a.owner_id = p.shared_by_id
       WHERE p.shared_with_id = ?1 AND a.id = ?2 AND a.deleted_at IS NULL AND a.visibility IN ('timeline', 'hidden')`,
    )
    .bind(userId, assetId)
    .first<{ ok: number }>();
  return row !== null;
}

/** Immich TimelineAccess.checkPartnerAccess: `sharedById` shares with `userId`. */
export async function isPartnerOf(db: D1Database, userId: string, sharedById: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS ok FROM partners WHERE shared_by_id = ?1 AND shared_with_id = ?2')
    .bind(sharedById, userId)
    .first<{ ok: number }>();
  return row !== null;
}

/** Immich getMyPartnerIds with timelineEnabled: sharers with inTimeline whose users are not deleted. */
export async function timelinePartnerIds(db: D1Database, userId: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT p.shared_by_id AS id FROM partners p
       JOIN users b ON b.id = p.shared_by_id AND b.deleted_at IS NULL
       JOIN users w ON w.id = p.shared_with_id AND w.deleted_at IS NULL
       WHERE p.shared_with_id = ?1 AND p.in_timeline = 1`,
    )
    .bind(userId)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}
