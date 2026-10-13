import type { Context } from 'hono';
import type { AppEnv } from '../app';
import type { AssetRow } from '../db/rows';
import { ImmichError } from '../http/errors';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_V4.test(v);

/**
 * Locked-folder assets are reachable only from a PIN-elevated session (stream A's `hasElevatedPermission`:
 * the session's pin_expires_at is in the future). Immich's checkOwnerAccess(…, hasElevatedPermission).
 * Owner checks only: partner and other non-owner access never includes locked assets.
 */
export function allowLocked(c: Context<AppEnv>): boolean {
  return c.get('auth').hasElevatedPermission === true;
}

/** Immich's requireElevatedPermission: 401 unless the session is PIN-elevated. */
export function requireElevated(c: Context<AppEnv>): void {
  if (!allowLocked(c)) throw new ImmichError(401, 'Elevated permission is required');
}

export type AssetPermission = 'read' | 'update' | 'delete' | 'download' | 'copy';

/** SQLite allows 100 bound parameters per statement on D1. */
const IN_CHUNK = 90;

/**
 * Loads the assets the caller may use for a permission. Immich's requireAccess answers 400 when any id is
 * missing or not accessible. Owner-only here; albums, partners and shared links extend this one function.
 */
export async function requireAssetAccess(
  c: Context<AppEnv>,
  ids: string[],
  permission: AssetPermission,
): Promise<Map<string, AssetRow>> {
  const unique = [...new Set(ids)];
  const found = new Map<string, AssetRow>();
  const locked = allowLocked(c);
  const ownerId = c.get('auth').user.id;
  for (let i = 0; i < unique.length; i += IN_CHUNK) {
    const chunk = unique.slice(i, i + IN_CHUNK);
    const marks = chunk.map((_, n) => `?${n + 2}`).join(',');
    const { results } = await c.env.DB.prepare(`SELECT * FROM assets WHERE owner_id = ?1 AND id IN (${marks})`)
      .bind(ownerId, ...chunk)
      .all<AssetRow>();
    for (const row of results) if (row.visibility !== 'locked' || locked) found.set(row.id, row);
  }
  if (found.size !== unique.length) throw new ImmichError(400, `Not found or no asset.${permission} access`);
  return found;
}

/** Validates an `ids`-style array body field: UUIDv4 strings, bounded. */
export function parseIds(value: unknown, name = 'ids', max = 5000): string[] {
  if (!Array.isArray(value) || !value.every(isUuid)) throw new ImmichError(400, `${name} must be an array of UUIDs`);
  if (value.length > max) throw new ImmichError(400, `${name} has too many entries`);
  return value;
}

export async function readJson(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ImmichError(400, 'Request body must be a JSON object');
  return body as Record<string, unknown>;
}
