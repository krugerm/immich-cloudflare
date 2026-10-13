import { DurableObject } from 'cloudflare:workers';
import { version as serverVersion } from '../server/routes';
import { connectErrorPacket, eventPacket, namespaceOf, newSid, openPacket, PING_INTERVAL, PING_TIMEOUT } from './protocol';

interface Attachment {
  /** Engine.IO session id. */
  sid: string;
  /** Immich session id of the authenticated client (Immich's per-session room). */
  sessionId: string;
  /** True once the client joined the main namespace (`40`). Events go only to connected sockets. */
  connected: boolean;
  /** Last time the client sent anything; used for the ping timeout. */
  lastSeen: number;
}

/**
 * One instance per user (`idFromName(userId)`). Holds that user's Socket.IO connections with the
 * WebSocket Hibernation API, answers the Engine.IO/Socket.IO handshake, sends server pings from an
 * alarm, and fans out event packets from `send`.
 */
export class RealtimeHub extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('expected websocket', { status: 426 });
    const sessionId = new URL(request.url).searchParams.get('sessionId');
    if (!sessionId) return new Response('missing sessionId', { status: 400 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [sessionId]);
    const att: Attachment = { sid: newSid(), sessionId, connected: false, lastSeen: Date.now() };
    server.serializeAttachment(att);
    server.send(openPacket(att.sid));
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + PING_INTERVAL);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return; // the clients send no binary packets
    const att = ws.deserializeAttachment() as Attachment;
    att.lastSeen = Date.now();
    switch (message[0]) {
      case '1': // Engine.IO CLOSE
        ws.close(1000, 'client close');
        return;
      case '2': // client ping (probe); Engine.IO v4 pings come from the server, but answer anyway
        ws.send('3' + message.slice(1));
        break;
      case '4':
        if (!this.onSocketPacket(ws, att, message.slice(1))) return;
        break;
      // '3' (pong) only refreshes lastSeen
    }
    ws.serializeAttachment(att);
  }

  /** Handles a Socket.IO packet; returns false when the socket was closed. */
  private onSocketPacket(ws: WebSocket, att: Attachment, body: string): boolean {
    const nsp = namespaceOf(body);
    if (body[0] === '0') {
      if (nsp !== '/') {
        ws.send(connectErrorPacket(nsp, 'Invalid namespace'));
        return true;
      }
      att.connected = true;
      ws.send('40' + JSON.stringify({ sid: newSid() }));
      // Immich's version service sends this to every newly connected socket.
      ws.send(eventPacket('on_server_version', [serverVersion(this.env)]));
    } else if (body[0] === '1' && nsp === '/') {
      ws.close(1000, 'namespace disconnect');
      return false;
    }
    // EVENT/ACK packets from the client are ignored: Immich clients emit nothing the server handles.
    return true;
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // already closed
    }
  }

  async webSocketError(): Promise<void> {}

  /** Server-initiated Engine.IO pings; drops sockets that stopped answering. Re-arms only while sockets remain. */
  async alarm(): Promise<void> {
    const now = Date.now();
    let live = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment;
      try {
        if (now - att.lastSeen > PING_INTERVAL + PING_TIMEOUT) {
          ws.close(1000, 'ping timeout');
          continue;
        }
        ws.send('2');
        live++;
      } catch {
        // socket already gone
      }
    }
    if (live > 0) await this.ctx.storage.setAlarm(now + PING_INTERVAL);
  }

  /**
   * Sends ready-made Engine.IO frames to the user's sockets that joined the main namespace,
   * or only to one Immich session's sockets. Returns the number of sockets reached.
   */
  async send(packets: string[], sessionId?: string): Promise<number> {
    let reached = 0;
    for (const ws of sessionId ? this.ctx.getWebSockets(sessionId) : this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment;
      if (!att.connected) continue;
      try {
        for (const p of packets) ws.send(p);
        reached++;
      } catch {
        // socket closing; the close handler cleans up
      }
    }
    return reached;
  }

  /**
   * Closes the sockets of one Immich session, or all of the user's sockets when `sessionId` is omitted.
   * Each connected socket first gets `packets` (e.g. on_session_delete) and a Socket.IO DISCONNECT (`41`),
   * which socket.io-client treats as a server disconnect and does not retry. Returns the number closed.
   */
  async disconnect(sessionId?: string, packets: string[] = []): Promise<number> {
    let closed = 0;
    for (const ws of sessionId ? this.ctx.getWebSockets(sessionId) : this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment;
      try {
        if (att.connected) for (const p of [...packets, '41']) ws.send(p);
        ws.close(1000, 'session ended');
        closed++;
      } catch {
        // already closed
      }
    }
    return closed;
  }

  /** Number of open sockets (tests and diagnostics). */
  async count(): Promise<number> {
    return this.ctx.getWebSockets().length;
  }
}
