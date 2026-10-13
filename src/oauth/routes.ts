import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { requireAdmin, requireAuth } from '../auth/session';
import { ImmichError } from '../http/errors';
import { mapUserAdmin } from '../users/map';

// OAuth is not configured (server/features reports oauth: false). These endpoints answer as Immich does when
// OAuth is disabled; OAuth login, linking and claim sync are deferred.

export const oauthRoutes = new Hono<AppEnv>();

const MOBILE_REDIRECT = 'app.immich:///oauth-callback';
const disabled = () => {
  throw new ImmichError(400, 'OAuth is not enabled');
};

oauthRoutes.get('/oauth/mobile-redirect', (c) => {
  const query = c.req.url.split('?', 2)[1] ?? '';
  return c.redirect(`${MOBILE_REDIRECT}?${query}`, 302);
});
oauthRoutes.post('/oauth/authorize', disabled);
oauthRoutes.post('/oauth/callback', disabled);
oauthRoutes.post('/oauth/backchannel-logout', () => {
  throw new ImmichError(400, 'Received backchannel logout request but OAuth is not enabled');
});
oauthRoutes.post('/oauth/link', requireAuth, disabled);
// No user can have an OAuth id, so unlinking changes nothing.
oauthRoutes.post('/oauth/unlink', requireAuth, (c) => c.json(mapUserAdmin(c.get('auth').user)));
oauthRoutes.post('/admin/auth/unlink-all', requireAdmin, (c) => c.body(null, 204));
