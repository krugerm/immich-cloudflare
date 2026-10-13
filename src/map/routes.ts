// stream G: map markers from exif coordinates; reverse geocoding uses the GeoNames table (src/geo).
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { requireAuth } from '../auth/session';
import { reverseGeocode } from '../geo/geocode';
import { ImmichError } from '../http/errors';
import { readBool, readIso, type Bind } from '../search/criteria';

export const mapRoutes = new Hono<AppEnv>();

mapRoutes.get('/map/markers', requireAuth, async (c) => {
  const q = c.req.query();
  const userId = c.get('auth').user.id;
  for (const k of ['withPartners', 'withSharedAlbums']) if (q[k] !== undefined) readBool(q[k], k); // validated, owner-only for now
  const where = ['a.owner_id = ?', 'a.deleted_at IS NULL', 'e.latitude IS NOT NULL', 'e.longitude IS NOT NULL'];
  const binds: Bind[] = [userId];
  // Immich: isArchived=true widens timeline to timeline+archive (own assets); otherwise timeline only.
  where.push(q.isArchived !== undefined && readBool(q.isArchived, 'isArchived') ? "a.visibility IN ('timeline', 'archive')" : "a.visibility = 'timeline'");
  if (q.isFavorite !== undefined) {
    where.push('a.is_favorite = ?');
    binds.push(readBool(q.isFavorite, 'isFavorite') ? 1 : 0);
  }
  if (q.fileCreatedAfter !== undefined) {
    where.push('a.file_created_at >= ?');
    binds.push(readIso(q.fileCreatedAfter, 'fileCreatedAfter'));
  }
  if (q.fileCreatedBefore !== undefined) {
    where.push('a.file_created_at <= ?');
    binds.push(readIso(q.fileCreatedBefore, 'fileCreatedBefore'));
  }
  const { results } = await c.env.DB.prepare(
    `SELECT a.id, e.latitude AS lat, e.longitude AS lon, e.city, e.state, e.country
     FROM assets a JOIN asset_exif e ON e.asset_id = a.id WHERE ${where.join(' AND ')} ORDER BY a.file_created_at DESC, a.id DESC`,
  )
    .bind(...binds)
    .all();
  return c.json(results);
});

mapRoutes.get('/map/reverse-geocode', requireAuth, async (c) => {
  const n: Record<string, number> = {};
  for (const k of ['lat', 'lon']) {
    const v = c.req.query(k);
    n[k] = v === undefined || v.trim() === '' ? NaN : Number(v);
    const max = k === 'lat' ? 90 : 180;
    if (!Number.isFinite(n[k]) || Math.abs(n[k]) > max) throw new ImmichError(400, `${k} must be a number between -${max} and ${max}`);
  }
  // Immich always answers with one element, all null when nothing is within 25 km.
  return c.json([await reverseGeocode(c.env.DB, n.lat, n.lon)]);
});
