import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { requireElevated } from '../assets/access';
import { requireAuth } from '../auth/session';
import type { UserRow } from '../db/rows';
import type { Dto } from '../gen/dto';
import { ImmichError } from '../http/errors';
import { emailToAvatarColor } from './map';

export const userExtraRoutes = new Hono<AppEnv>();

export function mapUserShort(u: UserRow): Dto<'UserResponseDto'> {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    profileImagePath: u.profile_image_path,
    avatarColor: (u.avatar_color as Dto<'UserAvatarColor'> | null) ?? emailToAvatarColor(u.email),
    profileChangedAt: u.profile_changed_at,
  };
}

export async function assetStats(db: D1Database, ownerId: string, q: Record<string, string | undefined>): Promise<Dto<'AssetStatsResponseDto'>> {
  const where = ['owner_id = ?1', q.isTrashed === 'true' ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL'];
  const binds: unknown[] = [ownerId];
  if (q.visibility) {
    binds.push(q.visibility);
    where.push(`visibility = ?${binds.length}`);
  }
  if (q.isFavorite === 'true' || q.isFavorite === 'false') where.push(`is_favorite = ${q.isFavorite === 'true' ? 1 : 0}`);
  const { results } = await db
    .prepare(`SELECT type, count(*) AS n FROM assets WHERE ${where.join(' AND ')} GROUP BY type`)
    .bind(...binds)
    .all<{ type: string; n: number }>();
  const images = results.find((r) => r.type === 'IMAGE')?.n ?? 0;
  const videos = results.find((r) => r.type === 'VIDEO')?.n ?? 0;
  return { images, videos, total: results.reduce((a, r) => a + r.n, 0) };
}

const DAY = 86_400_000;
const isoDay = /^\d{4}-\d{2}-\d{2}$/;

export async function calendarHeatmap(db: D1Database, ownerId: string, q: Record<string, string | undefined>): Promise<Dto<'CalendarHeatmapResponseDto'>> {
  const { from, to } = q;
  if (!from || !to || !isoDay.test(from) || !isoDay.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
    throw new ImmichError(400, 'from and to must be YYYY-MM-DD dates');
  }
  const days = (Date.parse(to) - Date.parse(from)) / DAY + 1;
  if (days < 1 || days > 400) throw new ImmichError(400, 'Invalid date range');
  const col = q.type === 'Taken' ? 'local_date_time' : 'created_at';
  const { results } = await db
    .prepare(`SELECT substr(${col}, 1, 10) AS d, count(*) AS n FROM assets WHERE owner_id = ?1 AND deleted_at IS NULL AND substr(${col}, 1, 10) BETWEEN ?2 AND ?3 GROUP BY d`)
    .bind(ownerId, from, to)
    .all<{ d: string; n: number }>();
  const byDay = new Map(results.map((r) => [r.d, r.n]));
  const series = Array.from({ length: days }, (_, i) => {
    const date = new Date(Date.parse(from) + i * DAY).toISOString().slice(0, 10);
    return { date, count: byDay.get(date) ?? 0 };
  });
  return { from, to, series, totalCount: series.reduce((a, s) => a + s.count, 0) };
}

userExtraRoutes.get('/assets/statistics', requireAuth, async (c) => {
  if (c.req.query('visibility') === 'locked') requireElevated(c); // Immich getStatistics
  return c.json(await assetStats(c.env.DB, c.get('auth').user.id, c.req.query()));
});
userExtraRoutes.get('/users/me/calendar-heatmap', requireAuth, async (c) =>
  c.json(await calendarHeatmap(c.env.DB, c.get('auth').user.id, c.req.query())),
);

userExtraRoutes.get('/users', requireAuth, async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM users WHERE deleted_at IS NULL ORDER BY name, id').all<UserRow>();
  return c.json(results.map(mapUserShort));
});

// Cluster groups are not implemented; each user is alone in a group named after their id.
// stream D: the GET /partners stub moved to src/partners/routes.ts.
userExtraRoutes.get('/cluster-groups/requests', requireAuth, (c) => c.json([]));
userExtraRoutes.get('/cluster-groups/:id/users', requireAuth, (c) => {
  const { user } = c.get('auth');
  if (c.req.param('id') !== user.id) throw new ImmichError(403, 'Forbidden');
  return c.json([mapUserShort(user)]);
});
userExtraRoutes.get('/cluster-groups/:id/requests', requireAuth, (c) => {
  if (c.req.param('id') !== c.get('auth').user.id) throw new ImmichError(403, 'Forbidden');
  return c.json([]);
});
