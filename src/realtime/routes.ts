import { Hono, type Context } from 'hono';
import type { AppEnv } from '../app';
import { extractToken, findSession } from '../auth/session';
import { disconnectSession } from './emit';
import { connectErrorPacket, newSid, openPacket } from './protocol';

export const realtimeRoutes = new Hono<AppEnv>();

/**
 * Unauthenticated upgrade. Immich accepts the transport and then refuses the namespace, so the client
 * gets `connect_error` and stops instead of retrying in a loop. Same here: open, CONNECT_ERROR, close.
 */
function refuse(): Response {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  server.send(openPacket(newSid()));
  server.send(connectErrorPacket('/', 'unauthorized'));
  server.close(1000, 'unauthorized');
  return new Response(null, { status: 101, webSocket: client });
}

/** True when extractToken would fall through to the `immich_access_token` cookie (no header/query/bearer token). */
function cookieIsCredential(req: Request): boolean {
  const h = req.headers;
  const auth = h.get('authorization');
  const bearer = auth?.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : null;
  // Same order and emptiness rules as extractToken, so an empty header cannot skip this check.
  return !(h.get('x-immich-user-token') || h.get('x-immich-session-token') || new URL(req.url).searchParams.get('sessionKey') || bearer);
}

/** Engine.IO error bodies, as the reference server sends them. */
const engineError = (c: Context<AppEnv>, code: number, message: string) => c.json({ code, message }, 400);

async function socketIo(c: Context<AppEnv>): Promise<Response> {
  const q = new URL(c.req.url).searchParams;
  if (q.get('EIO') !== '4') return engineError(c, 5, 'Unsupported protocol version');
  // Both Immich clients use transports: ['websocket']; long-polling is not served.
  if (q.get('transport') !== 'websocket') return engineError(c, 0, 'Transport unknown');
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') return engineError(c, 3, 'Bad request');

  // Cross-site WebSocket hijacking: browsers attach the cookie to upgrades from any page, and WebSockets
  // have no CORS. When the cookie is the credential, the Origin (always sent by browsers) must be ours.
  if (cookieIsCredential(c.req.raw)) {
    const origin = c.req.header('origin');
    if (origin && origin !== new URL(c.req.url).origin) return c.json({ code: 3, message: 'Forbidden origin' }, 403);
  }

  const token = extractToken(c.req.raw);
  const auth = token ? await findSession(c.env.DB, token) : null;
  if (!auth) return refuse();

  const hub = c.env.REALTIME.get(c.env.REALTIME.idFromName(auth.user.id));
  const res = await hub.fetch(`https://realtime.internal/connect?sessionId=${encodeURIComponent(auth.session.id)}`, {
    headers: { upgrade: 'websocket' },
  });
  // Revocation deletes the session first and disconnects it afterwards. A revocation that landed between the
  // lookup above and the hub accepting this socket sent its disconnect too early, so check again now that the
  // socket is registered: if the session is gone, close it (a later revocation's disconnect reaches it anyway).
  if (res.status === 101 && !(await findSession(c.env.DB, token!))) {
    c.executionCtx.waitUntil(disconnectSession(c.env, auth.user.id, auth.session.id));
  }
  return res;
}

realtimeRoutes.get('/socket.io', socketIo);
realtimeRoutes.get('/socket.io/*', socketIo);
