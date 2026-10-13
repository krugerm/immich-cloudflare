import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { requireAdmin } from '../auth/session';
import storageTemplateOptions from '../defaults/storage-template-options.json';
import systemConfig from '../defaults/system-config.json';
import { getSystemConfig } from '../config/store'; // stream D
import userDefaults from '../defaults/user-preferences.json';
import type { UserRow } from '../db/rows';
import { ImmichError } from '../http/errors';
import { listSessions } from '../sessions/routes';
import { assetStats, calendarHeatmap } from '../users/extra';
import { mapUserAdmin } from '../users/map';

export const adminRoutes = new Hono<AppEnv>();

const INTEGRITY_TYPES = ['untracked_file', 'missing_file', 'checksum_mismatch'];

// stream D: the stored config merged over Immich's defaults; writes live in src/config/routes.ts.
adminRoutes.get('/system-config', requireAdmin, async (c) => c.json(await getSystemConfig(c.env.DB)));
adminRoutes.get('/system-config/defaults', requireAdmin, (c) => c.json(systemConfig));
adminRoutes.get('/system-config/storage-template-options', requireAdmin, (c) => c.json(storageTemplateOptions));

async function findUser(c: { env: Env }, id: string): Promise<UserRow> {
  const u = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(id).first<UserRow>();
  if (!u) throw new ImmichError(400, 'User not found');
  return u;
}

adminRoutes.get('/admin/users', requireAdmin, async (c) => {
  const { id, withDeleted } = c.req.query();
  const where = [withDeleted === 'true' ? '1 = 1' : 'deleted_at IS NULL'];
  const binds: string[] = [];
  if (id) {
    binds.push(id);
    where.push('id = ?1');
  }
  const { results } = await c.env.DB.prepare(`SELECT * FROM users WHERE ${where.join(' AND ')} ORDER BY name, id`).bind(...binds).all<UserRow>();
  return c.json(results.map(mapUserAdmin));
});
adminRoutes.get('/admin/users/:id', requireAdmin, async (c) => c.json(mapUserAdmin(await findUser(c, c.req.param('id')))));
adminRoutes.get('/admin/users/:id/preferences', requireAdmin, async (c) => {
  const u = await findUser(c, c.req.param('id'));
  const merge = (base: any, over: any): any => {
    if (typeof base !== 'object' || base === null || Array.isArray(base)) return over ?? base;
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(over ?? {})) out[k] = merge(base[k], v);
    return out;
  };
  return c.json(merge(userDefaults, JSON.parse(u.preferences || '{}')));
});
adminRoutes.get('/admin/users/:id/statistics', requireAdmin, async (c) => {
  const u = await findUser(c, c.req.param('id'));
  return c.json(await assetStats(c.env.DB, u.id, c.req.query()));
});
adminRoutes.get('/admin/users/:id/sessions', requireAdmin, async (c) => {
  const u = await findUser(c, c.req.param('id'));
  return c.json(await listSessions(c.env.DB, u.id, null));
});
adminRoutes.get('/admin/users/:id/calendar-heatmap', requireAdmin, async (c) => {
  const u = await findUser(c, c.req.param('id'));
  return c.json(await calendarHeatmap(c.env.DB, u.id, c.req.query()));
});

adminRoutes.get('/server/statistics', requireAdmin, async (c) => {
  const { results } = await c.env.DB
    .prepare(
      `SELECT u.id, u.name, u.quota_bytes,
         coalesce(sum(a.type = 'IMAGE'), 0) AS photos, coalesce(sum(a.type = 'VIDEO'), 0) AS videos,
         coalesce(sum(CASE WHEN a.type = 'IMAGE' THEN a.file_size END), 0) AS usage_photos,
         coalesce(sum(CASE WHEN a.type = 'VIDEO' THEN a.file_size END), 0) AS usage_videos
       FROM users u LEFT JOIN assets a ON a.owner_id = u.id AND a.deleted_at IS NULL
       WHERE u.deleted_at IS NULL GROUP BY u.id ORDER BY u.name, u.id`,
    )
    .all<{ id: string; name: string; quota_bytes: number | null; photos: number; videos: number; usage_photos: number; usage_videos: number }>();
  const usageByUser = results.map((r) => ({
    userId: r.id,
    userName: r.name,
    photos: r.photos,
    videos: r.videos,
    usage: r.usage_photos + r.usage_videos,
    usagePhotos: r.usage_photos,
    usageVideos: r.usage_videos,
    quotaSizeInBytes: r.quota_bytes,
  }));
  const sum = (k: 'photos' | 'videos' | 'usage' | 'usagePhotos' | 'usageVideos') => usageByUser.reduce((a, u) => a + u[k], 0);
  return c.json({
    photos: sum('photos'), videos: sum('videos'), usage: sum('usage'),
    usagePhotos: sum('usagePhotos'), usageVideos: sum('usageVideos'), usageByUser,
  });
});

// Queues and jobs: see src/jobs/routes.ts (stream F).

adminRoutes.get('/libraries', requireAdmin, (c) => c.json([]));
adminRoutes.get('/libraries/:id', requireAdmin, () => {
  throw new ImmichError(404, 'Library not found');
});

adminRoutes.get('/admin/integrity/summary', requireAdmin, (c) => c.json({ untracked_file: 0, missing_file: 0, checksum_mismatch: 0 }));
adminRoutes.get('/admin/integrity/report', requireAdmin, (c) => {
  if (!INTEGRITY_TYPES.includes(c.req.query('type') ?? '')) throw new ImmichError(400, 'Invalid report type');
  return c.json({ items: [] });
});
adminRoutes.get('/admin/database-backups', requireAdmin, (c) => c.json({ backups: [] }));
