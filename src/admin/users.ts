import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { hashPassword } from '../auth/password';
import { requireAdmin } from '../auth/session';
import { commit } from '../db/changes';
import { ImmichError } from '../http/errors';
import { readDto, uuidPathParam } from '../http/validate';
import { disconnectUser } from '../realtime/emit';
import { mapUserAdmin } from '../users/map';
import { assertEmailAvailable } from '../users/me';
import { updatedPreferences } from '../users/preferences';
import { getUserAnyState, getUserById, insertUserAdmin, updateUser, userUpdate } from '../users/repo';

// Immich user-admin.service.ts. Creating a user here is how a family member gets an account.

export const adminUserRoutes = new Hono<AppEnv>();

/** sanitize-filename as Immich applies it to storage labels; an empty result means no label. */
function sanitizeLabel(label: string | null | undefined): string | null | undefined {
  if (label === undefined || label === null) return label;
  const clean = label
    .replace(/[/?<>\\:*|"]/g, '')
    .replace(/[\x00-\x1f\x80-\x9f]/g, '')
    .replace(/^\.+$/, '')
    .slice(0, 255);
  return clean === '' ? null : clean;
}

async function assertLabelAvailable(db: D1Database, label: string | null | undefined, userId: string | null) {
  if (!label) return;
  const other = await db.prepare('SELECT id FROM users WHERE storage_label = ?1').bind(label).first<{ id: string }>();
  if (other && other.id !== userId) throw new ImmichError(400, 'Storage label already in use by another account');
}

async function findOrFail(db: D1Database, id: string, withDeleted: boolean) {
  const u = withDeleted ? await getUserAnyState(db, id) : await getUserById(db, id);
  if (!u) throw new ImmichError(400, 'User not found');
  return u;
}

adminUserRoutes.post('/admin/users', requireAdmin, async (c) => {
  const dto = await readDto(c, 'UserAdminCreateDto');
  if (!dto.password) throw new ImmichError(400, 'password is required');
  await assertEmailAvailable(c.env.DB, dto.email, null);
  const storageLabel = sanitizeLabel(dto.storageLabel) ?? null;
  await assertLabelAvailable(c.env.DB, storageLabel, null);
  const user = await insertUserAdmin(c.env.DB, {
    email: dto.email,
    name: dto.name,
    password: dto.password,
    isAdmin: dto.isAdmin ?? false,
    avatarColor: dto.avatarColor ?? null,
    pinCodeHash: dto.pinCode ? await hashPassword(dto.pinCode) : null,
    storageLabel,
    quotaBytes: dto.quotaSizeInBytes ?? null,
    shouldChangePassword: dto.shouldChangePassword ?? false,
  });
  return c.json(mapUserAdmin(user), 201);
});

adminUserRoutes.put('/admin/users/:id', requireAdmin, async (c) => {
  const auth = c.get('auth');
  const id = uuidPathParam(c);
  const dto = await readDto(c, 'UserAdminUpdateDto');
  await findOrFail(c.env.DB, id, false);
  if (dto.isAdmin !== undefined && dto.isAdmin !== (auth.user.is_admin === 1) && auth.user.id === id) {
    throw new ImmichError(400, 'Admin status can only be changed by another admin');
  }
  if (dto.email) await assertEmailAvailable(c.env.DB, dto.email, id);
  const storageLabel = dto.storageLabel === '' ? null : sanitizeLabel(dto.storageLabel);
  await assertLabelAvailable(c.env.DB, storageLabel, id);
  const updated = await updateUser(c.env.DB, id, {
    email: dto.email?.toLowerCase(),
    name: dto.name,
    password_hash: dto.password ? await hashPassword(dto.password) : undefined,
    pin_code: dto.pinCode === null ? null : dto.pinCode ? await hashPassword(dto.pinCode) : undefined,
    avatar_color: dto.avatarColor,
    storage_label: storageLabel,
    should_change_password: dto.shouldChangePassword === undefined ? undefined : dto.shouldChangePassword ? 1 : 0,
    quota_bytes: dto.quotaSizeInBytes,
    is_admin: dto.isAdmin === undefined ? undefined : dto.isAdmin ? 1 : 0,
  });
  return c.json(mapUserAdmin(updated));
});

/**
 * Soft delete. `force` marks the user `removing`, which the daily purge hard-deletes at its next run;
 * otherwise the purge removes the user after Immich's default delay of 7 days.
 */
adminUserRoutes.delete('/admin/users/:id', requireAdmin, async (c) => {
  const auth = c.get('auth');
  const id = uuidPathParam(c);
  const dto = await readDto(c, 'UserAdminDeleteDto');
  await findOrFail(c.env.DB, id, false);
  if (auth.user.id === id) throw new ImmichError(403, 'Cannot delete your own account');
  const updated = await updateUser(c.env.DB, id, { status: dto.force ? 'removing' : 'deleted', deleted_at: new Date().toISOString() });
  // stream H: the user's sessions stop authenticating now (rows stay for restore), so close all of the user's sockets
  c.executionCtx.waitUntil(disconnectUser(c.env, id));
  return c.json(mapUserAdmin(updated));
});

adminUserRoutes.post('/admin/users/:id/restore', requireAdmin, async (c) => {
  const id = uuidPathParam(c);
  await findOrFail(c.env.DB, id, true);
  const updated = await updateUser(c.env.DB, id, { status: 'active', deleted_at: null });
  return c.json(mapUserAdmin(updated));
});

adminUserRoutes.put('/admin/users/:id/preferences', requireAdmin, async (c) => {
  const id = uuidPathParam(c);
  const dto = await readDto(c, 'UserPreferencesUpdateDto');
  const u = await findOrFail(c.env.DB, id, false);
  const { prefs, stored } = updatedPreferences(u.preferences, dto);
  await commit(c.env.DB, [userUpdate(id, { preferences: stored })]);
  return c.json(prefs);
});
