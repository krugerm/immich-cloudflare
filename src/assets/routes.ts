import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { requireAdmin, requireAuth } from '../auth/session';
import type { ExifRow } from '../db/rows';
import { loadOwnedAsset } from '../media/routes';
import { getSharedLink, requireAuthOrSharedLink } from '../shared-links/auth';
import { assetExtras } from '../stacks/repo';
import { mapAssetResponse } from './map';
import { DEFAULTS, getSystemConfig, type SystemConfig } from '../config/store'; // stream D
import { loginPageMessage } from '../server/routes';

export const assetRoutes = new Hono<AppEnv>();

assetRoutes.get('/assets/:id', requireAuthOrSharedLink(), async (c) => {
  const a = await loadOwnedAsset(c, c.req.param('id'));
  const e = await c.env.DB.prepare('SELECT * FROM asset_exif WHERE asset_id = ?1').bind(a.id).first<ExifRow>();
  const res = mapAssetResponse(a, e);
  const shared = getSharedLink(c);
  // Immich mapAsset: isFavorite is `auth.user.id === ownerId && isFavorite` (stream D), so partners, album members and
  // shared links of another owner never see it; a shared link without metadata gets the sanitized shape (stream C)
  if (a.owner_id !== (shared?.owner.id ?? c.get('auth').user.id)) res.isFavorite = false;
  if (shared && !shared.link.show_metadata) {
    const { id, type, originalMimeType, thumbhash, localDateTime, duration, livePhotoVideoId, width, height } = res;
    return c.json({ id, type, originalMimeType, thumbhash, localDateTime, duration, livePhotoVideoId, hasMetadata: false, width, height });
  }
  return c.json({ ...res, ...(await assetExtras(c.env.DB, a)) }); // stream E: stack and tags
});

// Viewer side panels; real implementations arrive with ML (phase 4). Albums are in src/albums/routes.ts.
// Faces and people: src/people/routes.ts (phase 4 E).
assetRoutes.get('/assets/:id/ocr', requireAuth, (c) => c.json([]));
// Admin pages read these states; nothing records them yet.
assetRoutes.get('/system-metadata/admin-onboarding', requireAuth, requireAdmin, (c) => c.json({ isOnboarded: true }));
assetRoutes.get('/system-metadata/version-check-state', requireAuth, requireAdmin, (c) =>
  c.json({ checkedAt: null, releaseVersion: null }),
);
assetRoutes.get('/system-metadata/reverse-geocoding-state', requireAuth, requireAdmin, (c) =>
  c.json({ lastImportFileName: null, lastUpdate: null }),
);

// Memories: src/memories (stream F). Notifications: src/notifications (stream D).

// Login page config; unauthenticated. OAuth is not implemented, password login is always on.
// stream D: the login message, custom CSS and OAuth button text come from the stored system config.
const publicConfig = (config: SystemConfig) => ({
  oauth: { autoLaunch: false, buttonText: config.oauth.buttonText, enabled: false },
  passwordLogin: { enabled: true },
  server: { loginPageMessage: config.server.loginPageMessage },
  theme: { customCss: config.theme.customCss },
});
// The web login page reads this endpoint (getPublicConfig), so the "Forgot password?" link is appended here too.
assetRoutes.get('/public/config', async (c) => {
  const body = publicConfig(await getSystemConfig(c.env.DB));
  body.server.loginPageMessage = loginPageMessage(body.server.loginPageMessage, body.passwordLogin.enabled, c.req.header('user-agent'));
  return c.json(body);
});
assetRoutes.get('/public/config/defaults', (c) => c.json(publicConfig(DEFAULTS)));
