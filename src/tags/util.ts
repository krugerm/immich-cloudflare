import type { Context } from 'hono';
import type { AppEnv } from '../app';
import { ImmichError } from '../http/errors';

// stream E: input validation shared by the tag and stack routes (Immich uses z.uuidv4)
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const HEX_COLOR_RE = /^#?([0-9A-Fa-f]{3}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;

export function uuidParam(value: string | undefined, name: string): string {
  if (!value || !UUID_RE.test(value)) throw new ImmichError(400, `${name} must be a UUID`);
  return value;
}

export async function jsonBody(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ImmichError(400, 'Request body must be a JSON object');
  return body as Record<string, unknown>;
}

export function uuidArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !UUID_RE.test(v))) {
    throw new ImmichError(400, `${name} must be an array of UUIDs`);
  }
  return value as string[];
}

/** Stores colours with a leading `#`, like Immich's hexColor transform. */
export function colorValue(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string' || !HEX_COLOR_RE.test(value)) throw new ImmichError(400, 'color must be a hex colour');
  return value.startsWith('#') ? value : `#${value}`;
}

export function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export const json = (ids: string[]) => JSON.stringify(ids);
