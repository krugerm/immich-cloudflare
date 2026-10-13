import { SELF } from 'cloudflare:test';
import { expect } from 'vitest';
import { BASE, createUser, login } from './helpers';

export const URL_WS = `${BASE}/api/socket.io/?EIO=4&transport=websocket`;

/** A test client: collects text frames and lets the test wait for the next one. */
export class Client {
  frames: string[] = [];
  closed = false;
  private waiters: Array<() => void> = [];
  constructor(public ws: WebSocket) {
    ws.accept();
    ws.addEventListener('message', (e) => {
      this.frames.push(String(e.data));
      this.wake();
    });
    ws.addEventListener('close', () => {
      this.closed = true;
      this.wake();
    });
  }
  private wake() {
    for (const w of this.waiters.splice(0)) w();
  }
  /** Waits until a frame matching `pred` arrives (consuming frames up to it). */
  async next(pred: (f: string) => boolean = () => true, timeoutMs = 2000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.frames.findIndex(pred);
      if (i !== -1) return this.frames.splice(0, i + 1)[i];
      if (this.closed || Date.now() > deadline) throw new Error(`no matching frame; got ${JSON.stringify(this.frames)} closed=${this.closed}`);
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 50);
      });
    }
  }
  async waitClosed(timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (!this.closed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    return this.closed;
  }
  /** Frames received within a short window, for "nothing arrives" assertions. */
  async drain(ms = 150): Promise<string[]> {
    await new Promise((r) => setTimeout(r, ms));
    return this.frames.splice(0);
  }
}

export async function open(headers: Record<string, string>, url = URL_WS): Promise<{ res: Response; client: Client | null }> {
  const res = await SELF.fetch(url, { headers: { upgrade: 'websocket', ...headers } });
  return { res, client: res.webSocket ? new Client(res.webSocket) : null };
}

/** Opens and completes the Engine.IO + Socket.IO handshake. */
export async function connect(headers: Record<string, string>) {
  const { res, client } = await open(headers);
  expect(res.status).toBe(101);
  const c = client!;
  await c.next((f) => f.startsWith('0'));
  c.ws.send('40');
  await c.next((f) => f.startsWith('40'));
  await c.next((f) => f.startsWith('42["on_server_version"'));
  return c;
}

export async function userWithToken(email: string) {
  const user = await createUser({ email, isAdmin: false });
  const token = await login(email);
  return { user, token };
}
