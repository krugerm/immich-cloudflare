import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { requireAdmin, requireAuth } from '../auth/session';
import { checkSchema } from '../config/schema';
import { getSystemConfig } from '../config/store';
import type { Dto } from '../gen/dto';
import { ImmichError } from '../http/errors';

// stream D: Immich notification.service.ts, notification-admin.service.ts and notification.repository.ts.
export const notificationRoutes = new Hono<AppEnv>();

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEVELS = ['success', 'error', 'warning', 'info'];
const TYPES = ['JobFailed', 'BackupFailed', 'SystemMessage', 'AlbumInvite', 'AlbumUpdate', 'ClusterGroupRequest', 'Custom'];

interface NotificationRow {
  id: string;
  user_id: string;
  level: string;
  type: string;
  title: string;
  description: string | null;
  data: string | null;
  read_at: string | null;
  created_at: string;
  deleted_at: string | null;
}

export function mapNotification(n: NotificationRow): Dto<'NotificationDto'> {
  return {
    id: n.id,
    createdAt: n.created_at,
    level: n.level as Dto<'NotificationLevel'>,
    type: n.type as Dto<'NotificationType'>,
    title: n.title,
    ...(n.description !== null ? { description: n.description } : {}),
    ...(n.data !== null ? { data: JSON.parse(n.data) } : {}),
    ...(n.read_at !== null ? { readAt: n.read_at } : {}),
  };
}

async function body(req: { json: () => Promise<unknown> }, schema: string): Promise<Record<string, any>> {
  const value = await req.json().catch(() => undefined);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ImmichError(400, 'Invalid request body');
  const errors = checkSchema(schema, value);
  if (errors.length) throw new ImmichError(400, errors.slice(0, 10).join('; '));
  return value as Record<string, any>;
}

function uuidParam(id: string | undefined): string {
  if (!id || !UUID_V4.test(id)) throw new ImmichError(400, 'id must be a UUID');
  return id;
}

/** `undefined` leaves read_at alone, `null` clears it, a date sets it. */
const readAtValue = (v: unknown): string | null | undefined => (v === undefined ? undefined : v === null ? null : new Date(v as string).toISOString());

/** Immich NotificationAccess.checkOwnerAccess: every id is a notification of the user (soft-deleted ones count). */
async function requireOwner(db: D1Database, userId: string, ids: string[], permission: string): Promise<void> {
  const unique = [...new Set(ids)];
  const row = await db
    .prepare(`SELECT count(*) AS n FROM notifications WHERE user_id = ?1 AND id IN (${unique.map((_, i) => `?${i + 2}`).join(', ')})`)
    .bind(userId, ...unique)
    .first<number>('n');
  if (row !== unique.length) throw new ImmichError(400, `Not found or no ${permission} access`);
}

const MAX_IDS = 90; // D1 allows 100 bound parameters per statement

function idList(ids: string[]): string[] {
  if (ids.length > MAX_IDS) throw new ImmichError(400, `ids must contain at most ${MAX_IDS} elements`);
  return ids;
}

notificationRoutes.get('/notifications', requireAuth, async (c) => {
  const { id, level, type, unread } = c.req.query();
  const where = ['user_id = ?1', 'deleted_at IS NULL'];
  const binds: unknown[] = [c.get('auth').user.id];
  if (id !== undefined) {
    if (!UUID_V4.test(id)) throw new ImmichError(400, 'id must be a UUID');
    binds.push(id);
    where.push(`id = ?${binds.length}`);
  }
  if (level !== undefined) {
    if (!LEVELS.includes(level)) throw new ImmichError(400, `level must be one of: ${LEVELS.join(', ')}`);
    binds.push(level);
    where.push(`level = ?${binds.length}`);
  }
  if (type !== undefined) {
    if (!TYPES.includes(type)) throw new ImmichError(400, `type must be one of: ${TYPES.join(', ')}`);
    binds.push(type);
    where.push(`type = ?${binds.length}`);
  }
  if (unread !== undefined && unread !== 'true' && unread !== 'false') throw new ImmichError(400, 'unread must be a boolean');
  if (unread === 'true') where.push('read_at IS NULL');
  const { results } = await c.env.DB.prepare(`SELECT * FROM notifications WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id`)
    .bind(...binds)
    .all<NotificationRow>();
  return c.json(results.map(mapNotification));
});

notificationRoutes.put('/notifications', requireAuth, async (c) => {
  const dto = await body(c.req, 'NotificationUpdateAllDto');
  const ids = idList(dto.ids);
  await requireOwner(c.env.DB, c.get('auth').user.id, ids, 'notification.update');
  const readAt = readAtValue(dto.readAt);
  if (readAt !== undefined) {
    await c.env.DB.prepare(`UPDATE notifications SET read_at = ?1, updated_at = ?2 WHERE id IN (${ids.map((_, i) => `?${i + 3}`).join(', ')})`)
      .bind(readAt, new Date().toISOString(), ...ids)
      .run();
  }
  return c.body(null, 204);
});

notificationRoutes.delete('/notifications', requireAuth, async (c) => {
  const dto = await body(c.req, 'NotificationDeleteAllDto');
  const ids = idList(dto.ids);
  await requireOwner(c.env.DB, c.get('auth').user.id, ids, 'notification.delete');
  const now = new Date().toISOString();
  await c.env.DB.prepare(`UPDATE notifications SET deleted_at = ?1, updated_at = ?1 WHERE deleted_at IS NULL AND id IN (${ids.map((_, i) => `?${i + 2}`).join(', ')})`)
    .bind(now, ...ids)
    .run();
  return c.body(null, 204);
});

async function liveNotification(db: D1Database, id: string): Promise<NotificationRow> {
  const n = await db.prepare('SELECT * FROM notifications WHERE id = ?1 AND deleted_at IS NULL').bind(id).first<NotificationRow>();
  if (!n) throw new ImmichError(400, 'Notification not found');
  return n;
}

notificationRoutes.get('/notifications/:id', requireAuth, async (c) => {
  const id = uuidParam(c.req.param('id'));
  await requireOwner(c.env.DB, c.get('auth').user.id, [id], 'notification.read');
  return c.json(mapNotification(await liveNotification(c.env.DB, id)));
});

notificationRoutes.put('/notifications/:id', requireAuth, async (c) => {
  const id = uuidParam(c.req.param('id'));
  const dto = await body(c.req, 'NotificationUpdateDto');
  await requireOwner(c.env.DB, c.get('auth').user.id, [id], 'notification.update');
  await liveNotification(c.env.DB, id);
  const readAt = readAtValue(dto.readAt);
  if (readAt !== undefined) {
    await c.env.DB.prepare('UPDATE notifications SET read_at = ?2, updated_at = ?3 WHERE id = ?1 AND deleted_at IS NULL')
      .bind(id, readAt, new Date().toISOString())
      .run();
  }
  return c.json(mapNotification(await liveNotification(c.env.DB, id)));
});

notificationRoutes.delete('/notifications/:id', requireAuth, async (c) => {
  const id = uuidParam(c.req.param('id'));
  await requireOwner(c.env.DB, c.get('auth').user.id, [id], 'notification.delete');
  const now = new Date().toISOString();
  await c.env.DB.prepare('UPDATE notifications SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1 AND deleted_at IS NULL').bind(id, now).run();
  return c.body(null, 204);
});

notificationRoutes.post('/admin/notifications', requireAdmin, async (c) => {
  const dto = await body(c.req, 'NotificationCreateDto');
  const user = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?1').bind(dto.userId).first();
  if (!user) throw new ImmichError(400, 'User not found');
  const now = new Date().toISOString();
  const row: NotificationRow = {
    id: crypto.randomUUID(),
    user_id: dto.userId,
    level: dto.level ?? 'info',
    type: dto.type ?? 'Custom',
    title: dto.title,
    description: dto.description ?? null,
    data: dto.data === undefined ? null : JSON.stringify(dto.data),
    read_at: null, // Immich's create ignores readAt
    created_at: now,
    deleted_at: null,
  };
  await c.env.DB.prepare(
    `INSERT INTO notifications (id, user_id, level, type, title, description, data, read_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?8)`,
  )
    .bind(row.id, row.user_id, row.level, row.type, row.title, row.description, row.data, now)
    .run();
  return c.json(mapNotification(row), 201);
});

// Immich renders React email components; this server renders the custom (or stored) template with Immich's
// replaceTemplateTags, or a short built-in body when no template is set.
const replaceTemplateTags = (template: string, vars: Record<string, string>) => template.replaceAll(/{(.*?)}/g, (_, key: string) => vars[key] || `{${key}}`);
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function externalDomain(domain: string): string {
  return domain || 'https://my.immich.app'; // Immich getExternalDomain fallback
}

notificationRoutes.post('/admin/notifications/templates/:name', requireAdmin, async (c) => {
  const name = c.req.param('name');
  const dto = await body(c.req, 'TemplateDto');
  const { server, templates } = await getSystemConfig(c.env.DB);
  const baseUrl = externalDomain(server.externalDomain);
  const samples: Record<string, { stored: string; vars: Record<string, string>; fallback: string }> = {
    welcome: {
      stored: templates.email.welcomeTemplate,
      vars: { baseUrl, displayName: 'John Doe', username: 'john@doe.com', password: 'thisIsAPassword123' },
      fallback: 'Hey {displayName}! A new account has been created for you. Username: {username}. Password: {password}. Login at {baseUrl}.',
    },
    'album-invite': {
      stored: templates.email.albumInviteTemplate,
      vars: { baseUrl, albumId: '1', albumName: "John Doe's Favorites", senderName: 'John Doe', recipientName: 'Jane Doe' },
      fallback: 'Hey {recipientName}! {senderName} has added you to the album {albumName}. View it at {baseUrl}/albums/{albumId}.',
    },
    'album-update': {
      stored: templates.email.albumUpdateTemplate,
      vars: { baseUrl, albumId: '1', albumName: 'Favorite Photos', recipientName: 'Jane Doe' },
      fallback: 'Hey {recipientName}! New media has been added to {albumName}. View it at {baseUrl}/albums/{albumId}.',
    },
  };
  const sample = samples[name];
  if (!sample) return c.json({ name, html: '' });
  const text = replaceTemplateTags(dto.template || sample.stored || sample.fallback, sample.vars);
  return c.json({ name, html: `<!DOCTYPE html><html><body><p>${escapeHtml(text)}</p></body></html>` });
});

// No email is sent in phase 2: SMTP verification fails as Immich's does for an unreachable server.
notificationRoutes.post('/admin/notifications/test-email', requireAdmin, async (c) => {
  await body(c.req, 'AdminConfigSmtpDto');
  throw new ImmichError(400, 'Failed to verify SMTP configuration');
});
