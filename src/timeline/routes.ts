import { Hono, type Context } from 'hono';
import type { AppEnv } from '../app';
import { isPartnerOf, timelinePartnerIds } from '../access/partners';
import { uuid } from '../albums/input';
import { requireAlbumAccess } from '../albums/repo';
import { ImmichError } from '../http/errors';
import { getSharedLink, requireAuthOrSharedLink } from '../shared-links/auth';
import { UUID_RE } from '../tags/util';

export const timelineRoutes = new Hono<AppEnv>();

/** stream E: tagId must be a UUID of one of the caller's tags (Immich's requireAccess, TagRead). */
async function requireTagFilter(db: D1Database, userId: string | null, tagId: string | undefined): Promise<void> {
  if (tagId === undefined) return;
  if (!UUID_RE.test(tagId)) throw new ImmichError(400, 'tagId must be a UUID');
  // A shared-link caller has no tag.read access (Immich's checkAccess for a shared link grants no tags).
  const tag = userId ? await db.prepare('SELECT 1 AS ok FROM tags WHERE id = ?1 AND user_id = ?2').bind(tagId, userId).first() : null;
  if (!tag) throw new ImmichError(400, 'Not found or no tag.read access');
}

/** phase 4 E: personId must be one of the caller's people (Immich's requireAccess, PersonRead). */
async function requirePersonFilter(db: D1Database, userId: string | null, personId: string | undefined): Promise<void> {
  if (personId === undefined) return;
  if (!UUID_RE.test(personId)) throw new ImmichError(400, 'personId must be a UUID');
  const row = userId
    ? await db.prepare('SELECT 1 AS ok FROM people WHERE owner_id = ?1 AND person_group_id = ?2').bind(userId, personId.toLowerCase()).first()
    : null;
  if (!row) throw new ImmichError(400, 'Not found or no person.read access');
}

/**
 * Immich timeBucketChecks + buildTimeBucketOptions. Returns the base WHERE condition:
 * - the locked timeline needs a PIN-elevated session (401, G2; a shared link is never elevated);
 * - `albumId` (stream C): the caller needs album read access (a shared-link caller only to its link's album) and the
 *   timeline is the album's assets of every owner; another owner's locked asset is never listed;
 * - `userId`/`withPartners` (stream D): `userId` defaults to the caller when there is no `albumId`; another user needs
 *   a partnership (timeline.read), and `withPartners` adds the caller's in-timeline partners.
 */
async function scope(c: Context<AppEnv>, q: Record<string, string>): Promise<{ sql: string; binds: unknown[] }> {
  const db = c.env.DB;
  const shared = getSharedLink(c);
  const me = shared ? null : c.get('auth').user.id;
  const elevated = !shared && c.get('auth').hasElevatedPermission === true;
  if (q.visibility === 'locked' && !elevated) throw new ImmichError(401, 'Elevated permission is required');

  const where: string[] = [];
  const binds: unknown[] = [];
  const bind = (v: unknown) => {
    binds.push(v);
    return `?${binds.length}`;
  };
  if (q.albumId) {
    const albumId = uuid(q.albumId, 'albumId');
    await requireAlbumAccess(c, albumId, 'read');
    where.push(`a.id IN (SELECT asset_id FROM album_assets WHERE album_id = ${bind(albumId)})`);
    where.push(`(a.visibility != 'locked' OR a.owner_id = ${bind(me ?? '')})`);
  }
  const target = q.userId || (q.albumId ? undefined : (me ?? undefined));
  if (target !== undefined || (shared && !q.albumId)) {
    // Immich TimelineRead: the caller itself or a partner sharing with the caller; a shared link has neither.
    if (!me || (target !== me && !(await isPartnerOf(db, me, target!)))) throw new ImmichError(400, 'Not found or no timeline.read access');
    if (q.visibility === 'archive' && target !== me) throw new ImmichError(400, 'Not found or no archive.read access');
    if (q.visibility === 'locked' && target !== me) throw new ImmichError(400, "You may not access another user's locked timeline");
  }
  if (q.withPartners === 'true') {
    const archived = q.visibility === 'archive' || q.visibility === undefined;
    if (q.visibility === 'locked' || archived || q.isFavorite === 'true' || q.isFavorite === 'false' || q.isTrashed === 'true') {
      throw new ImmichError(400, 'withPartners is only supported for non-archived, non-trashed, non-favorited, non-locked assets');
    }
  }
  if (target !== undefined) {
    const owners = q.withPartners === 'true' ? [...new Set([target, ...(await timelinePartnerIds(db, me!))])] : [target];
    where.push(`a.owner_id IN (${owners.map(bind).join(', ')})`);
  }
  await requireTagFilter(db, me, q.tagId);
  await requirePersonFilter(db, me, q.personId); // phase 4 E
  return { sql: where.join(' AND '), binds };
}

/** Builds the WHERE clause shared by both endpoints from Immich's TimeBucketDto query. */
function filters(
  q: Record<string, string>,
  base: { sql: string; binds: unknown[] },
  kind: 'buckets' | 'bucket' = 'buckets',
): { sql: string; binds: unknown[] } {
  const where = [base.sql];
  const binds: unknown[] = [...base.binds];
  if (q.isTrashed === 'true') where.push('a.deleted_at IS NOT NULL');
  else where.push('a.deleted_at IS NULL');
  if (q.visibility) {
    binds.push(q.visibility);
    where.push(`a.visibility = ?${binds.length}`);
  } else {
    // Also applies to the trash view, so hidden live-photo videos are not listed as separate trash items.
    where.push("a.visibility IN ('timeline', 'archive')");
  }
  if (q.isFavorite === 'true') where.push('a.is_favorite = 1');
  if (q.isFavorite === 'false') where.push('a.is_favorite = 0');
  if (q.personId) {
    // phase 4 E: assets with a visible, non-deleted face of the person (access checked in scope)
    binds.push(q.personId.toLowerCase());
    where.push(`a.id IN (SELECT f.asset_id FROM asset_faces f WHERE f.person_group_id = ?${binds.length} AND f.deleted_at IS NULL AND f.is_visible = 1)`);
  }
  if (q.tagId) {
    binds.push(q.tagId);
    where.push(`a.id IN (SELECT ta.asset_id FROM tag_asset ta WHERE ta.tag_id IN (WITH RECURSIVE d(id) AS (SELECT ?${binds.length} UNION ALL SELECT t.id FROM tags t JOIN d ON t.parent_id = d.id) SELECT id FROM d))`);
  }
  if (q.withStacked === 'true') {
    // Immich collapses a stack to its primary asset; the bucket counts and the bucket listing use different (equivalent) predicates.
    where.push(
      kind === 'buckets'
        ? 'EXISTS (SELECT 1 FROM stacks s WHERE s.id = a.stack_id AND s.primary_asset_id = a.id) OR a.stack_id IS NULL'
        : 'NOT EXISTS (SELECT 1 FROM stacks s WHERE s.id = a.stack_id AND s.primary_asset_id <> a.id)',
    );
    where[where.length - 1] = `(${where[where.length - 1]})`;
  }
  return { sql: where.join(' AND '), binds };
}

timelineRoutes.get('/timeline/buckets', requireAuthOrSharedLink(), async (c) => {
  const q = c.req.query();
  const f = filters(q, await scope(c, q));
  const order = q.order === 'asc' ? 'ASC' : 'DESC';
  const { results } = await c.env.DB.prepare(
    `SELECT strftime('%Y-%m-01', a.local_date_time) AS timeBucket, count(*) AS count
     FROM assets a WHERE ${f.sql} GROUP BY timeBucket ORDER BY timeBucket ${order}`,
  )
    .bind(...f.binds)
    .all<{ timeBucket: string; count: number }>();
  return c.json(results);
});

timelineRoutes.get('/timeline/bucket', requireAuthOrSharedLink(), async (c) => {
  const q = c.req.query();
  if (!q.timeBucket) throw new ImmichError(400, 'timeBucket is required');
  const bucket = q.timeBucket.replace(/^[+-]/, '').slice(0, 10);
  const f = filters(q, await scope(c, q), 'bucket');
  const shared = getSharedLink(c);
  // A link that hides metadata hides location too: no coordinates, and no city or country.
  const hideLocation = !!shared && !shared.link.show_metadata;
  if (hideLocation) q.withCoordinates = 'false';
  f.binds.push(bucket);
  const order = q.order === 'asc' ? 'ASC' : 'DESC';
  const { results } = await c.env.DB.prepare(
    `SELECT a.*, e.city, e.country, e.latitude, e.longitude, e.projection_type,
            CASE WHEN a.stack_id IS NULL THEN 0 ELSE (SELECT count(*) FROM assets m WHERE m.stack_id = a.stack_id AND m.deleted_at IS NULL AND m.visibility = 'timeline') END AS stack_count
     FROM assets a LEFT JOIN asset_exif e ON e.asset_id = a.id
     WHERE ${f.sql} AND strftime('%Y-%m-01', a.local_date_time) = ?${f.binds.length}
     ORDER BY a.local_date_time ${order}`,
  )
    .bind(...f.binds)
    .all<Record<string, any>>();

  const col = <T>(fn: (r: Record<string, any>) => T) => results.map(fn);
  const withCoordinates = q.withCoordinates === 'true';
  // Immich: isFavorite is the viewer's own flag (album timelines hold other owners' assets)
  const viewer = shared ? shared.owner.id : c.get('auth').user.id;
  return c.json({
    id: col((r) => r.id),
    ownerId: col((r) => r.owner_id),
    createdAt: col((r) => r.created_at),
    fileCreatedAt: col((r) => r.file_created_at),
    localOffsetHours: col((r) => (Date.parse(r.local_date_time) - Date.parse(r.file_created_at)) / 3_600_000),
    duration: col((r) => r.duration),
    isFavorite: col((r) => r.is_favorite === 1 && r.owner_id === viewer),
    isImage: col((r) => r.type === 'IMAGE'),
    isTrashed: col((r) => r.deleted_at !== null),
    livePhotoVideoId: col((r) => r.live_photo_video_id),
    projectionType: col((r) => r.projection_type ?? null),
    ratio: col((r) => (r.width && r.height ? r.width / r.height : 1)),
    thumbhash: col((r) => r.thumbhash),
    visibility: col((r) => r.visibility),
    city: col((r) => (hideLocation ? null : (r.city ?? null))),
    country: col((r) => (hideLocation ? null : (r.country ?? null))),
    ...(q.withStacked === 'true' ? { stack: col((r) => (r.stack_id && r.stack_count > 0 ? [r.stack_id, String(r.stack_count)] : null)) } : {}),
    ...(withCoordinates ? { latitude: col((r) => r.latitude ?? null), longitude: col((r) => r.longitude ?? null) } : {}),
  });
});
