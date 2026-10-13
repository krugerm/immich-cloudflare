// Warms the search container when an app opens, so the first smart search does not wait for a cold start. Both the
// web app and the iOS app call these endpoints at start-up or on resume (users/me) and on the explore and search pages.
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../app';

export const SEARCH_INSTANCE = 'search';
/** Per isolate: an app opening fires several of these requests, and one wake-up covers the sleepAfter window. */
const WARM_INTERVAL_MS = 60_000;
let lastWarm = 0;

/** Authenticated endpoints only, so a stranger cannot keep the container awake. */
export const WARM_PATHS = ['/api/users/me', '/api/search/explore', '/api/search/suggestions', '/api/people'];

export function resetWarmThrottle(): void {
  lastWarm = 0;
}

/** Sends `/warm` to the search container, at most once a minute per isolate; failures are logged. */
export async function warmSearch(env: Env, now = Date.now()): Promise<boolean> {
  const ns = env.ML_SEARCH as Env['ML_SEARCH'] | undefined;
  if (!ns || now - lastWarm < WARM_INTERVAL_MS) return false;
  lastWarm = now;
  try {
    await ns.get(ns.idFromName(SEARCH_INSTANCE)).fetch('http://container/warm', { method: 'POST' });
  } catch (err) {
    console.error('search container warm-up failed', err);
  }
  return true;
}

/** After a successful (so authenticated) GET of a warm path, wakes the search container in the background. */
export const warmOnAppOpen: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  if (c.req.method !== 'GET' || c.res.status !== 200 || !WARM_PATHS.includes(c.req.path)) return;
  try {
    c.executionCtx.waitUntil(warmSearch(c.env));
  } catch {
    // called without an execution context (app.fetch in a unit test)
  }
};
