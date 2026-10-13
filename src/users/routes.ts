import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { requireAuth } from '../auth/session';
import defaults from '../defaults/user-preferences.json';
import { mapUserAdmin } from './map';

export const userRoutes = new Hono<AppEnv>();

function merge(base: any, over: any): any {
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return over ?? base;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) out[k] = merge(base[k], v);
  return out;
}

userRoutes.get('/users/me', requireAuth, (c) => c.json(mapUserAdmin(c.get('auth').user)));
userRoutes.get('/users/me/preferences', requireAuth, (c) =>
  c.json(merge(defaults, JSON.parse(c.get('auth').user.preferences || '{}'))),
);
