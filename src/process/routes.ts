import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { requireAuth } from '../auth/session';
import { ImmichError } from '../http/errors';

export const processRoutes = new Hono<AppEnv>();

processRoutes.post('/admin-cf/reprocess-failed', requireAuth, async (c) => {
  if (c.get('auth').user.is_admin !== 1) throw new ImmichError(403, 'Admin only');
  const { results } = await c.env.DB.prepare("SELECT id FROM assets WHERE status = 'failed' LIMIT 5000").all<{ id: string }>();
  for (let i = 0; i < results.length; i += 100) {
    await c.env.PROCESS_QUEUE.sendBatch(results.slice(i, i + 100).map((r) => ({ body: { assetId: r.id } })));
  }
  return c.json({ queued: results.length });
});
