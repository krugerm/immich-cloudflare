import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { requireAuth } from '../auth/session';
import { MEDIA_TYPES } from '../upload/media-types';
import { vectorStore } from '../ml/vectors'; // phase 4 G
import { getState } from './state';
import { countUsers } from '../users/repo';
import { getSystemConfig } from '../config/store'; // stream D

export const serverRoutes = new Hono<AppEnv>();

/** ServerVersionResponseDto from SERVER_VERSION (also sent as on_server_version by the realtime hub). */
export function version(env: Env) {
  const [major, minor, patch] = env.SERVER_VERSION.split('.').map(Number);
  return { major, minor, patch, prerelease: null };
}

serverRoutes.get('/server/version', (c) => c.json(version(c.env)));
serverRoutes.get('/server/version-history', requireAuth, (c) => c.json([]));
serverRoutes.get('/server/media-types', (c) => c.json(MEDIA_TYPES));

serverRoutes.get('/server/features', async (c) => {
  const ml = !!c.env.ML_CONTAINER && !!c.env.ML_QUEUE; // phase 4 G
  return c.json({
    configFile: false, duplicateDetection: ml && !!vectorStore(c.env, 'clip'), email: false,
    facialRecognition: ml && !!vectorStore(c.env, 'face') && !!c.env.CLUSTER_HUB, // phase 4 G: true when the bindings exist
    importFaces: false, map: true, // stream G
    oauth: false, oauthAutoLaunch: false, ocr: false, passwordLogin: true, realtimeTranscoding: false,
    reverseGeocoding: true, search: true, // phase 4 G: geodata_places lives in D1
    sidecar: false, smartSearch: ml && !!vectorStore(c.env, 'clip'),
    trash: (await getSystemConfig(c.env.DB)).trash.enabled, // stream B implements trash; Immich reports config.trash.enabled
  });
});

// The Immich web login page renders loginPageMessage as HTML ({@html}); the self-service reset link is appended here
// only, so the admin's stored text (GET /admin/config, /public/config) is unchanged.
const FORGOT_LINK = '<a href="/forgot-password">Forgot password?</a>';

// The Immich mobile apps send `immich-android/<version>` (HttpClientManager.kt) or `immich-ios/<version>`
// (URLSessionManager.swift) and never display loginPageMessage (ServerConfig.fromDto drops it), so they get the
// admin text unchanged.
const MOBILE_UA = /^immich-(android|ios)\//i;

export function loginPageMessage(message: string, passwordLogin: boolean, userAgent = ''): string {
  if (!passwordLogin || MOBILE_UA.test(userAgent)) return message;
  return message ? `${message}<br>${FORGOT_LINK}` : FORGOT_LINK;
}

// stream D: config-backed fields come from the stored system config (Immich server.service getSystemConfig).
serverRoutes.get('/server/config', async (c) => {
  const config = await getSystemConfig(c.env.DB);
  return c.json({
    externalDomain: config.server.externalDomain, isInitialized: (await countUsers(c.env.DB)) > 0, isOnboarded: true,
    loginPageMessage: loginPageMessage(config.server.loginPageMessage, config.passwordLogin.enabled, c.req.header('user-agent')), maintenanceMode: false,
    mapDarkStyleUrl: config.map.darkStyle, mapLightStyleUrl: config.map.lightStyle,
    minFaces: config.machineLearning.facialRecognition.minFaces, oauthButtonText: config.oauth.buttonText,
    publicUsers: config.server.publicUsers, trashDays: config.trash.days, userDeleteDelay: config.user.deleteDelay,
  });
});

serverRoutes.get('/server/about', requireAuth, async (c) =>
  c.json({
    version: `v${c.env.SERVER_VERSION}`,
    versionUrl: `https://github.com/immich-app/immich/releases/tag/v${c.env.SERVER_VERSION}`,
    licensed: (await getState(c.env.DB, 'license')) !== null, // stream F
  }),
);

serverRoutes.get('/server/storage', requireAuth, async (c) => {
  const used = (await c.env.DB.prepare('SELECT coalesce(sum(file_size), 0) AS n FROM assets').first<number>('n')) ?? 0;
  const size = 1024 ** 4; // nominal 1 TiB; R2 has no fixed capacity
  const fmt = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GiB`;
  return c.json({
    diskSize: fmt(size), diskSizeRaw: size, diskUse: fmt(used), diskUseRaw: used,
    diskAvailable: fmt(size - used), diskAvailableRaw: size - used,
    diskUsagePercentage: Math.round((used / size) * 10000) / 100,
  });
});
