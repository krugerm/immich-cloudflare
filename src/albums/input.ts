import type { Context } from 'hono';
import { ImmichError } from '../http/errors';

// Same pattern as the OpenAPI contract: Immich validates every id with z.uuidv4().
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_V4.test(v);
}

export function uuid(v: unknown, name: string): string {
  if (!isUuid(v)) throw new ImmichError(400, `${name} must be a UUID`);
  return v.toLowerCase();
}

export function optUuid(v: unknown, name: string): string | undefined {
  return v === undefined ? undefined : uuid(v, name);
}

export function uuidArray(v: unknown, name: string): string[] {
  if (!Array.isArray(v)) throw new ImmichError(400, `${name} must be an array`);
  return v.map((x, i) => uuid(x, `${name}[${i}]`));
}

export function optString(v: unknown, name: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new ImmichError(400, `${name} must be a string`);
  return v;
}

/** `string | null | undefined`; Immich turns '' into null for album descriptions and link fields. */
export function optNullableString(v: unknown, name: string): string | null | undefined {
  if (v === undefined || v === null) return v;
  return optString(v, name);
}

export function optBool(v: unknown, name: string): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw new ImmichError(400, `${name} must be a boolean`);
  return v;
}

export function optEnum<T extends string>(v: unknown, name: string, values: readonly T[]): T | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !values.includes(v as T)) throw new ImmichError(400, `${name} must be one of ${values.join(', ')}`);
  return v as T;
}

/** Query-string boolean as Immich's stringToBool: 'true' / 'false', anything else is a 400. */
export function queryBool(v: string | undefined, name: string): boolean | undefined {
  if (v === undefined) return undefined;
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new ImmichError(400, `${name} must be a boolean`);
}

export async function jsonObject(c: Context): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ImmichError(400, 'Request body must be a JSON object');
  return body as Record<string, unknown>;
}
