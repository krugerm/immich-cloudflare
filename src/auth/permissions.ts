import spec from '../../vendor/immich-openapi.json';

export const ALL = 'all';

export const PERMISSIONS = new Set<string>((spec as any).components.schemas.Permission.enum);

/** Operations Immich marks `@Authenticated({ permission: false })`: any API key may call them. */
const NO_PERMISSION = new Set(['POST /auth/validateToken', 'GET /api-keys/me', 'GET /workflows/triggers']);

/** Path with every parameter replaced by `*`, so `/users/{id}` (OpenAPI) and `/users/:id` (Hono) compare equal. */
const shape = (path: string) => path.replace(/\{[^}]+\}|:[^/]+/g, '*');

const required = new Map<string, string | false>();
for (const [path, ops] of Object.entries((spec as any).paths as Record<string, Record<string, any>>)) {
  for (const [method, op] of Object.entries(ops)) {
    const key = `${method.toUpperCase()} ${path}`;
    required.set(`${method.toUpperCase()} ${shape(path)}`, NO_PERMISSION.has(key) ? false : (op['x-immich-permission'] ?? ALL));
  }
}

/** The permission an API key needs for a route (`routePath` relative to /api), or false when none is needed. */
export function requiredPermission(method: string, routePath: string): string | false {
  const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  return required.get(`${m} ${shape(routePath)}`) ?? ALL;
}

/** Immich's isGranted: `all` grants everything, otherwise every requested permission must be held. */
export function isGranted(requested: string[], current: string[]): boolean {
  if (current.includes(ALL)) return true;
  return requested.every((p) => current.includes(p));
}
