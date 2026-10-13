import { env, SELF } from 'cloudflare:test';
import { insertUser } from '../src/users/repo';
import { BASE, createUser, login } from './helpers';

export type Headers = Record<string, string>;

export async function call(method: string, path: string, headers: Headers = {}, body?: unknown) {
  const init: RequestInit = { method, headers: { ...headers } };
  if (body !== undefined) {
    (init.headers as Headers)['content-type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await SELF.fetch(`${BASE}/api${path}`, init);
  const text = await res.text();
  let json: any = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: res.status, body: json, headers: res.headers };
}

export const tok = (token: string): Headers => ({ 'x-immich-user-token': token });
export const key = (secret: string): Headers => ({ 'x-api-key': secret });

/** An admin and a regular user, both logged in. */
export async function twoUsers() {
  const admin = await createUser();
  const bob = await insertUser(env.DB, { email: 'bob@example.com', password: 'bob-pass-12', name: 'Bob', isAdmin: false });
  const adminToken = await login();
  const bobToken = await login('bob@example.com', 'bob-pass-12');
  return { admin, bob, adminToken, bobToken };
}

export type SyncLine = { type: string; data: Record<string, any>; ack: string };

export async function syncLines(headers: Headers, types: string[]): Promise<SyncLine[]> {
  const res = await SELF.fetch(`${BASE}/api/sync/stream`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ types }),
  });
  if (res.status !== 200) throw new Error(`sync ${res.status}: ${await res.text()}`);
  return (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
