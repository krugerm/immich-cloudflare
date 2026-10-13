import spec from '../../vendor/immich-openapi.json';

type Schema = Record<string, any>;
const schemas = (spec as any).components.schemas as Record<string, Schema>;

const deref = (s: Schema): Schema => (s.$ref ? deref(schemas[s.$ref.split('/').pop()!]) : s);

function isUrl(v: string): boolean {
  try {
    new URL(v);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates request input against a schema of the pinned OpenAPI spec: types, required properties, enums,
 * patterns, minimum/maximum, minItems, nullable and the `uri` format. Unknown properties are not errors
 * (zod strips them); use `pick` to drop them.
 */
export function checkSchema(schema: Schema | string, value: unknown, path = '$'): string[] {
  const s = deref(typeof schema === 'string' ? { $ref: `#/components/schemas/${schema}` } : schema);
  if (value === null) return s.nullable ? [] : [`${path} must not be null`];
  if (s.allOf) return s.allOf.flatMap((x: Schema) => checkSchema(x, value, path));
  const alternatives = s.oneOf ?? s.anyOf;
  if (alternatives) return alternatives.some((x: Schema) => checkSchema(x, value, path).length === 0) ? [] : [`${path} is invalid`];
  const errors: string[] = [];
  if (s.enum && !s.enum.includes(value)) return [`${path} must be one of: ${s.enum.join(', ')}`];
  switch (s.type) {
    case 'string':
      if (typeof value !== 'string') return [`${path} must be a string`];
      if (s.pattern && !new RegExp(s.pattern, 'u').test(value)) errors.push(`${path} has an invalid format`);
      if (s.format === 'uri' && !isUrl(value)) errors.push(`${path} must be a URL`);
      break;
    case 'integer':
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return [`${path} must be a number`];
      if (s.type === 'integer' && !Number.isInteger(value)) errors.push(`${path} must be an integer`);
      if (s.minimum !== undefined && value < s.minimum) errors.push(`${path} must not be less than ${s.minimum}`);
      if (s.maximum !== undefined && value > s.maximum) errors.push(`${path} must not be greater than ${s.maximum}`);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') return [`${path} must be a boolean`];
      break;
    case 'array':
      if (!Array.isArray(value)) return [`${path} must be an array`];
      if (s.minItems !== undefined && value.length < s.minItems) errors.push(`${path} must contain at least ${s.minItems} elements`);
      value.forEach((v, i) => errors.push(...checkSchema(s.items, v, `${path}[${i}]`)));
      break;
    default:
      if (s.type === 'object' || s.properties) {
        if (typeof value !== 'object' || Array.isArray(value)) return [`${path} must be an object`];
        const obj = value as Record<string, unknown>;
        for (const key of s.required ?? []) if (obj[key] === undefined) errors.push(`${path}.${key} is required`);
        for (const [key, ps] of Object.entries(s.properties ?? {})) {
          if (obj[key] !== undefined) errors.push(...checkSchema(ps as Schema, obj[key], `${path}.${key}`));
        }
      }
  }
  return errors;
}

/** Keeps only the properties a schema declares, recursively (zod's default strip, Immich's applyVisibility). */
export function pick(schema: Schema | string, value: unknown): unknown {
  const s = deref(typeof schema === 'string' ? { $ref: `#/components/schemas/${schema}` } : schema);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return s.items ? value.map((v) => pick(s.items, v)) : value;
  if (!s.properties) return value;
  const out: Record<string, unknown> = {};
  for (const [key, ps] of Object.entries(s.properties)) {
    const v = (value as Record<string, unknown>)[key];
    if (v !== undefined) out[key] = pick(ps as Schema, v);
  }
  return out;
}
