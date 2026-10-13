import spec from '../vendor/immich-openapi.json';

type Schema = Record<string, any>;
const schemas = (spec as any).components.schemas as Record<string, Schema>;

function resolve(name: string): Schema {
  const s = schemas[name];
  if (!s) throw new Error(`unknown schema ${name}`);
  return s;
}

export function validate(schema: Schema | string, value: unknown, path = '$'): string[] {
  const s: Schema = typeof schema === 'string' ? resolve(schema) : schema;
  if (value === null && s.nullable) return [];
  if (s.$ref) return validate(resolve(s.$ref.split('/').pop()!), value, path);
  if (value === null) return [`${path}: null not allowed`];
  if (s.allOf) return s.allOf.flatMap((x: Schema) => validate(x, value, path));
  const alternatives = s.oneOf ?? s.anyOf;
  if (alternatives) {
    return alternatives.some((x: Schema) => validate(x, value, path).length === 0) ? [] : [`${path}: matches no alternative`];
  }
  const errors: string[] = [];
  if (s.enum && !s.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
  switch (s.type) {
    case 'string':
      if (typeof value !== 'string') return [`${path}: expected string, got ${typeof value}`];
      if (s.pattern && !new RegExp(s.pattern, 'u').test(value)) errors.push(`${path}: ${JSON.stringify(value)} does not match pattern`);
      break;
    case 'integer':
      if (!Number.isInteger(value)) errors.push(`${path}: expected integer, got ${JSON.stringify(value)}`);
      break;
    case 'number':
      if (typeof value !== 'number') errors.push(`${path}: expected number, got ${typeof value}`);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(`${path}: expected boolean, got ${typeof value}`);
      break;
    case 'array':
      if (!Array.isArray(value)) return [`${path}: expected array`];
      value.forEach((v, i) => errors.push(...validate(s.items, v, `${path}[${i}]`)));
      break;
    default:
      if (s.type === 'object' || s.properties) {
        if (typeof value !== 'object' || Array.isArray(value)) return [`${path}: expected object`];
        const obj = value as Record<string, unknown>;
        for (const key of s.required ?? []) if (!(key in obj) || obj[key] === undefined) errors.push(`${path}.${key}: required`);
        for (const [key, ps] of Object.entries(s.properties ?? {})) {
          if (obj[key] !== undefined) errors.push(...validate(ps as Schema, obj[key], `${path}.${key}`));
        }
      }
  }
  return errors;
}

export function expectSchema(name: string, value: unknown): void {
  const errors = validate(name, value);
  if (errors.length) throw new Error(`${name} contract violations:\n${errors.join('\n')}`);
}

export function expectResponse(path: string, method: string, status: number, body: unknown): void {
  const op = (spec as any).paths[path]?.[method.toLowerCase()];
  if (!op) throw new Error(`no operation ${method} ${path}`);
  const schema = op.responses[String(status)]?.content?.['application/json']?.schema;
  if (!schema) throw new Error(`no JSON schema for ${method} ${path} ${status}`);
  const errors = validate(schema, body);
  if (errors.length) throw new Error(`${method} ${path} ${status} contract violations:\n${errors.join('\n')}`);
}
