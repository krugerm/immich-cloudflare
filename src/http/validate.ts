// stream F: shared input validation helpers; every failure is a 400.
import type { Context } from 'hono';
import spec from '../../vendor/immich-openapi.json';
import type { Dto } from '../gen/dto';
import type { components } from '../gen/immich';
import { ImmichError } from './errors';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATETIME_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)$/;
const DATE_RE = /^\d{4}-\d\d-\d\d$/;

export const bad = (message: string): never => {
  throw new ImmichError(400, message);
};

export function uuidParam(value: string, what = 'id'): string {
  if (!UUID_RE.test(value)) bad(`${what} must be a UUID`);
  return value;
}

export function isoDatetime(value: unknown, what: string): string {
  if (typeof value !== 'string' || !DATETIME_RE.test(value) || Number.isNaN(Date.parse(value))) bad(`${what} must be an ISO 8601 datetime string`);
  return new Date(value as string).toISOString();
}

export function isoDate(value: unknown, what: string): string {
  if (typeof value !== 'string' || !DATE_RE.test(value) || Number.isNaN(Date.parse(value))) bad(`${what} must be an ISO date string (YYYY-MM-DD)`);
  return new Date(value as string).toISOString();
}

export function boolQuery(value: string | undefined, what: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value !== 'true' && value !== 'false') bad(`${what} must be a boolean`);
  return value === 'true';
}

export function intQuery(value: string | undefined, what: string, min = 1): number | undefined {
  if (value === undefined) return undefined;
  if (!/^-?\d+$/.test(value) || Number(value) < min) bad(`${what} must be an integer >= ${min}`);
  return Number(value);
}

export async function jsonObject(req: Request): Promise<Record<string, unknown>> {
  const body = await req.json().catch(() => null);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) bad('Request body must be a JSON object');
  return body as Record<string, unknown>;
}

// stream A: OpenAPI-schema DTO validation. The route-param helper is named uuidPathParam
// because stream F already exports uuidParam(value, what).

type Schema = Record<string, any>;
type SchemaName = keyof components['schemas'];

const schemas = (spec as any).components.schemas as Record<string, Schema>;
const ANY_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const patterns = new Map<string, RegExp>();

function pattern(source: string): RegExp {
  let re = patterns.get(source);
  if (!re) patterns.set(source, (re = new RegExp(source, 'u')));
  return re;
}

/** Checks `value` against an OpenAPI schema and returns it with unknown object keys removed (zod's default in Immich). */
function clean(s: Schema, value: unknown, path: string, errors: string[]): unknown {
  if (s.$ref) return clean(schemas[s.$ref.split('/').pop()!], value, path, errors);
  if (value === null) {
    if (!s.nullable) errors.push(`${path} must not be null`);
    return value;
  }
  if (s.allOf) {
    let out: unknown = value;
    for (const part of s.allOf) out = clean(part, out, path, errors);
    return out;
  }
  const alternatives = s.oneOf ?? s.anyOf;
  if (alternatives) {
    for (const alt of alternatives) {
      const errs: string[] = [];
      const out = clean(alt, value, path, errs);
      if (errs.length === 0) return out;
    }
    errors.push(`${path} is invalid`);
    return value;
  }
  if (s.enum && !s.enum.includes(value)) {
    errors.push(`${path} must be one of: ${s.enum.join(', ')}`);
    return value;
  }
  switch (s.type) {
    case 'string':
      if (typeof value !== 'string') errors.push(`${path} must be a string`);
      else {
        if (s.minLength !== undefined && value.length < s.minLength) errors.push(`${path} must be at least ${s.minLength} characters`);
        if (s.maxLength !== undefined && value.length > s.maxLength) errors.push(`${path} must be at most ${s.maxLength} characters`);
        if (s.pattern && !pattern(s.pattern).test(value)) errors.push(`${path} has an invalid format`);
        if (s.format === 'uuid' && !ANY_UUID_RE.test(value)) errors.push(`${path} must be a UUID`);
        if (s.format === 'date-time' && Number.isNaN(Date.parse(value))) errors.push(`${path} must be a date-time`);
      }
      return value;
    case 'integer':
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value) || (s.type === 'integer' && !Number.isInteger(value))) {
        errors.push(`${path} must be ${s.type === 'integer' ? 'an integer' : 'a number'}`);
      } else {
        if (s.minimum !== undefined && value < s.minimum) errors.push(`${path} must not be less than ${s.minimum}`);
        if (s.maximum !== undefined && value > s.maximum) errors.push(`${path} must not be greater than ${s.maximum}`);
      }
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(`${path} must be a boolean`);
      return value;
    case 'array':
      if (!Array.isArray(value)) {
        errors.push(`${path} must be an array`);
        return value;
      }
      if (s.minItems !== undefined && value.length < s.minItems) errors.push(`${path} must contain at least ${s.minItems} elements`);
      return value.map((v, i) => clean(s.items ?? {}, v, `${path}[${i}]`, errors));
    default: {
      if (s.type !== 'object' && !s.properties) return value;
      if (typeof value !== 'object' || Array.isArray(value)) {
        errors.push(`${path} must be an object`);
        return value;
      }
      const obj = value as Record<string, unknown>;
      for (const key of s.required ?? []) if (obj[key] === undefined) errors.push(`${path}.${key} is required`);
      if (!s.properties) return obj;
      const out: Record<string, unknown> = {};
      for (const [key, ps] of Object.entries(s.properties as Record<string, Schema>)) {
        if (obj[key] !== undefined) out[key] = clean(ps, obj[key], `${path}.${key}`, errors);
      }
      return out;
    }
  }
}

export function validateDto<K extends SchemaName>(name: K, value: unknown): Dto<K> {
  const errors: string[] = [];
  const out = clean(schemas[name as string], value, 'body', errors);
  if (errors.length) throw new ImmichError(400, errors.join('; '));
  return out as Dto<K>;
}

/** Parses and validates a JSON body. An empty body counts as `{}` (for DTOs whose fields are all optional). */
export async function readDto<K extends SchemaName>(c: Context, name: K): Promise<Dto<K>> {
  const text = await c.req.text();
  let body: unknown = {};
  if (text.trim() !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      throw new ImmichError(400, 'Invalid JSON body');
    }
  }
  return validateDto(name, body);
}

export function uuidPathParam(c: Context, name = 'id'): string {
  const v = c.req.param(name);
  if (!v || !ANY_UUID_RE.test(v)) throw new ImmichError(400, `${name} must be a UUID`);
  return v.toLowerCase();
}
