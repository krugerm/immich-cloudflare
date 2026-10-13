import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { requireAdmin, requireAuth } from '../auth/session';
import { DEFAULTS, getSystemConfig, updateSystemConfig, userConfig } from './store';

// stream D: Immich system-config.service.ts (config-admin, config-user and system-config controllers).
export const configRoutes = new Hono<AppEnv>();

const readBody = (req: { json: () => Promise<unknown> }) => req.json().catch(() => null);

configRoutes.get('/admin/config', requireAdmin, async (c) => c.json(await getSystemConfig(c.env.DB)));
configRoutes.get('/admin/config/defaults', requireAdmin, (c) => c.json(DEFAULTS));
configRoutes.put('/admin/config', requireAdmin, async (c) => c.json(await updateSystemConfig(c.env.DB, await readBody(c.req))));
// Deprecated alias of PUT /admin/config.
configRoutes.put('/system-config', requireAdmin, async (c) => c.json(await updateSystemConfig(c.env.DB, await readBody(c.req))));

configRoutes.get('/config', requireAuth, async (c) => c.json(userConfig(await getSystemConfig(c.env.DB))));
configRoutes.get('/config/defaults', requireAuth, (c) => c.json(userConfig(DEFAULTS)));
