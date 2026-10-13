import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { isGranted } from '../auth/permissions';
import { requireAuth, sha256Hex, type AuthContext } from '../auth/session';
import type { ApiKeyRow } from '../db/rows';
import type { Dto } from '../gen/dto';
import { ImmichError } from '../http/errors';
import { readDto, uuidPathParam } from '../http/validate';

// Immich api-key.service.ts. Only the SHA-256 of a key is stored; the plaintext is returned once, at create and rotate.

export const apiKeyRoutes = new Hono<AppEnv>();

export function mapApiKey(k: ApiKeyRow): Dto<'ApiKeyResponseDto'> {
  return {
    id: k.id,
    name: k.name,
    createdAt: k.created_at,
    updatedAt: k.updated_at,
    permissions: JSON.parse(k.permissions) as Dto<'Permission'>[],
  };
}

/** Immich's randomBytesAsText(32): base64 with non-word characters removed. */
function newSecret(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\W/g, '');
}

function getKey(db: D1Database, userId: string, id: string) {
  return db.prepare('SELECT * FROM api_keys WHERE id = ?1 AND user_id = ?2').bind(id, userId).first<ApiKeyRow>();
}

/** A key may only hand out permissions it holds itself (sessions may grant anything). */
function assertGrantable(auth: AuthContext, requested: string[], message: string) {
  if (auth.apiKey && !isGranted(requested, auth.apiKey.permissions)) throw new ImmichError(400, message);
}

apiKeyRoutes.get('/api-keys', requireAuth, async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM api_keys WHERE user_id = ?1 ORDER BY created_at DESC, id')
    .bind(c.get('auth').user.id)
    .all<ApiKeyRow>();
  return c.json(results.map(mapApiKey));
});

apiKeyRoutes.post('/api-keys', requireAuth, async (c) => {
  const auth = c.get('auth');
  const dto = await readDto(c, 'ApiKeyCreateDto');
  assertGrantable(auth, dto.permissions, 'Cannot grant permissions you do not have');
  const secret = newSecret();
  const now = new Date().toISOString();
  const row: ApiKeyRow = {
    id: crypto.randomUUID(),
    user_id: auth.user.id,
    name: dto.name || 'API Key',
    key_sha256: await sha256Hex(secret),
    permissions: JSON.stringify(dto.permissions),
    created_at: now,
    updated_at: now,
  };
  await c.env.DB.prepare(
    'INSERT INTO api_keys (id, user_id, name, key_sha256, permissions, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)',
  )
    .bind(row.id, row.user_id, row.name, row.key_sha256, row.permissions, now)
    .run();
  const apiKey = mapApiKey(row);
  return c.json({ ...apiKey, secret, apiKey }, 201);
});

apiKeyRoutes.get('/api-keys/me', requireAuth, async (c) => {
  const auth = c.get('auth');
  if (!auth.apiKey) throw new ImmichError(403, 'Not authenticated with an API Key');
  const key = await getKey(c.env.DB, auth.user.id, auth.apiKey.id);
  if (!key) throw new ImmichError(400, 'API Key not found');
  return c.json(mapApiKey(key));
});

apiKeyRoutes.get('/api-keys/:id', requireAuth, async (c) => {
  const key = await getKey(c.env.DB, c.get('auth').user.id, uuidPathParam(c));
  if (!key) throw new ImmichError(400, 'API Key not found');
  return c.json(mapApiKey(key));
});

apiKeyRoutes.put('/api-keys/:id', requireAuth, async (c) => {
  const auth = c.get('auth');
  const id = uuidPathParam(c);
  const dto = await readDto(c, 'ApiKeyUpdateDto');
  const key = await getKey(c.env.DB, auth.user.id, id);
  if (!key) throw new ImmichError(400, 'API Key not found');
  if (dto.permissions) assertGrantable(auth, dto.permissions, 'Cannot grant permissions you do not have');
  const updated: ApiKeyRow = {
    ...key,
    name: dto.name ?? key.name,
    permissions: dto.permissions ? JSON.stringify(dto.permissions) : key.permissions,
    updated_at: new Date().toISOString(),
  };
  await c.env.DB.prepare('UPDATE api_keys SET name = ?3, permissions = ?4, updated_at = ?5 WHERE id = ?1 AND user_id = ?2')
    .bind(id, auth.user.id, updated.name, updated.permissions, updated.updated_at)
    .run();
  return c.json(mapApiKey(updated));
});

apiKeyRoutes.post('/api-keys/:id/rotate', requireAuth, async (c) => {
  const auth = c.get('auth');
  const id = uuidPathParam(c);
  const key = await getKey(c.env.DB, auth.user.id, id);
  if (!key) throw new ImmichError(400, 'API Key not found');
  assertGrantable(auth, JSON.parse(key.permissions), 'Cannot rotate an API Key with permissions you do not have');
  const secret = newSecret();
  const updated: ApiKeyRow = { ...key, key_sha256: await sha256Hex(secret), updated_at: new Date().toISOString() };
  await c.env.DB.prepare('UPDATE api_keys SET key_sha256 = ?3, updated_at = ?4 WHERE id = ?1 AND user_id = ?2')
    .bind(id, auth.user.id, updated.key_sha256, updated.updated_at)
    .run();
  const apiKey = mapApiKey(updated);
  return c.json({ ...apiKey, secret, apiKey }, 201);
});

apiKeyRoutes.delete('/api-keys/:id', requireAuth, async (c) => {
  const auth = c.get('auth');
  const id = uuidPathParam(c);
  if (!(await getKey(c.env.DB, auth.user.id, id))) throw new ImmichError(400, 'API Key not found');
  await c.env.DB.prepare('DELETE FROM api_keys WHERE id = ?1 AND user_id = ?2').bind(id, auth.user.id).run();
  return c.body(null, 204);
});
