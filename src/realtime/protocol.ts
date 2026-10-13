/** Engine.IO v4 / Socket.IO v4 framing, the subset the Immich clients use over WebSocket. */

export const PING_INTERVAL = 25_000;
export const PING_TIMEOUT = 20_000;
export const MAX_PAYLOAD = 1_000_000;

export function newSid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(15));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_');
}

/** Engine.IO OPEN packet. */
export function openPacket(sid: string): string {
  return '0' + JSON.stringify({ sid, upgrades: [], pingInterval: PING_INTERVAL, pingTimeout: PING_TIMEOUT, maxPayload: MAX_PAYLOAD });
}

/** Socket.IO EVENT packet on the main namespace: `42["event",...args]`. */
export function eventPacket(event: string, args: unknown[]): string {
  return '42' + JSON.stringify([event, ...args]);
}

/** Socket.IO CONNECT_ERROR packet for a namespace. */
export function connectErrorPacket(nsp: string, message: string): string {
  return '44' + (nsp === '/' ? '' : `${nsp},`) + JSON.stringify({ message });
}

/** Namespace of a Socket.IO packet body (the text after the Engine.IO `4`). */
export function namespaceOf(body: string): string {
  // body = <type>[<nsp>,][<ack id>][<json>]
  if (body[1] !== '/') return '/';
  const comma = body.indexOf(',');
  return comma === -1 ? body.slice(1) : body.slice(1, comma);
}
