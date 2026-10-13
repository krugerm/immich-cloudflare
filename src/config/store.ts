import defaultsJson from '../defaults/system-config.json';
import type { Dto } from '../gen/dto';
import { ImmichError } from '../http/errors';
import { checkSchema, pick } from './schema';

export type SystemConfig = Dto<'AdminConfigDto'>;
type Json = Record<string, any>;

export const DEFAULTS = defaultsJson as unknown as SystemConfig;

const isPlainObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const clone = <T>(v: T): T => structuredClone(v);

/** Immich utils/misc getKeysDeep: dotted paths of every non-object leaf (arrays are leaves). */
function leafPaths(target: unknown, path: string[] = []): string[][] {
  if (!isPlainObject(target)) return [];
  return Object.entries(target).flatMap(([k, v]) => (v === undefined ? [] : isPlainObject(v) ? leafPaths(v, [...path, k]) : [[...path, k]]));
}

const getPath = (obj: unknown, path: string[]) => path.reduce<any>((o, k) => (isPlainObject(o) ? o[k] : undefined), obj);

function setPath(obj: Json, path: string[], value: unknown) {
  let o = obj;
  for (const k of path.slice(0, -1)) {
    if (!isPlainObject(o[k])) o[k] = {};
    o = o[k];
  }
  o[path[path.length - 1]] = value;
}

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Immich utils/config buildConfig: overlay the stored partial on the defaults, then normalise. */
export function buildConfig(partial: unknown): SystemConfig {
  const config = clone(DEFAULTS) as Json;
  for (const path of leafPaths(partial)) setPath(config, path, clone(getPath(partial, path)));
  const domain = config.server?.externalDomain;
  if (typeof domain === 'string' && domain.length > 0) {
    try {
      const url = new URL(domain);
      config.server.externalDomain = url.password && url.username ? `${url.protocol}//${url.username}:${url.password}@${url.host}` : url.origin;
    } catch {
      // stored values are validated on write
    }
  }
  const ffmpeg = config.ffmpeg;
  if (ffmpeg && Array.isArray(ffmpeg.acceptedVideoCodecs) && !ffmpeg.acceptedVideoCodecs.includes(ffmpeg.targetVideoCodec)) {
    ffmpeg.acceptedVideoCodecs.push(ffmpeg.targetVideoCodec);
  }
  if (ffmpeg && Array.isArray(ffmpeg.acceptedAudioCodecs) && !ffmpeg.acceptedAudioCodecs.includes(ffmpeg.targetAudioCodec)) {
    ffmpeg.acceptedAudioCodecs.push(ffmpeg.targetAudioCodec);
  }
  return config as SystemConfig;
}

export async function getSystemConfig(db: D1Database): Promise<SystemConfig> {
  const row = await db.prepare('SELECT value FROM system_config WHERE id = 1').first<string>('value');
  let partial: unknown = {};
  if (row) {
    try {
      partial = JSON.parse(row);
    } catch {
      console.error('stored system config is not JSON; using defaults');
    }
  }
  return buildConfig(partial);
}

/** Immich utils/config updateConfig: store only what differs from the defaults (empty values are dropped). */
function diffFromDefaults(config: Json): Json {
  const partial: Json = {};
  for (const path of leafPaths(DEFAULTS)) {
    const value = getPath(config, path);
    if (value === undefined || value === null || value === '') continue;
    if (equal(value, getPath(DEFAULTS, path))) continue;
    setPath(partial, path, value);
  }
  return partial;
}

/**
 * Validates `input` as an AdminConfigDto, runs Immich's ConfigValidate checks, stores the diff and returns
 * the resulting config.
 */
export async function updateSystemConfig(db: D1Database, input: unknown): Promise<SystemConfig> {
  if (!isPlainObject(input)) throw new ImmichError(400, 'Invalid system config');
  const errors = checkSchema('AdminConfigDto', input);
  const domain = getPath(input, ['server', 'externalDomain']);
  if (typeof domain === 'string' && domain !== '') {
    try {
      new URL(domain);
    } catch {
      errors.push('External domain must be an empty string or a valid URL');
    }
  }
  if (errors.length) throw new ImmichError(400, errors.slice(0, 20).join('; '));
  const next = pick('AdminConfigDto', input) as Json;

  const old = await getSystemConfig(db);
  // notification.service onConfigValidate: a changed, enabled SMTP config must pass transport verification.
  // This server cannot open SMTP connections, so verification always fails.
  if (next.notifications.smtp.enabled && !equal(old.notifications.smtp, next.notifications.smtp)) {
    throw new ImmichError(400, 'Invalid SMTP configuration');
  }

  await db
    .prepare('INSERT INTO system_config (id, value, updated_at) VALUES (1, ?1, ?2) ON CONFLICT (id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .bind(JSON.stringify(diffFromDefaults(next)), new Date().toISOString())
    .run();
  return getSystemConfig(db);
}

export const userConfig = (config: SystemConfig) => pick('UserConfigDto', config) as Dto<'UserConfigDto'>;
