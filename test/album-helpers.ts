import { SELF } from 'cloudflare:test';
import { authHeaders, BASE, createUser, login, uploadAsset } from './helpers';

// stream C test helpers

export async function call(token: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await SELF.fetch(`${BASE}/api${path}`, {
    method,
    headers: { ...(token ? authHeaders(token) : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

/** An admin (token `a`) and two non-admin users, Bob (`b`) and Carol (`c`). */
export async function twoUsers() {
  const admin = await createUser();
  const bob = await createUser({ email: 'bob@example.com', name: 'Bob', isAdmin: false });
  const carol = await createUser({ email: 'carol@example.com', name: 'Carol', isAdmin: false });
  return {
    admin,
    bob,
    carol,
    a: await login(),
    b: await login('bob@example.com'),
    c: await login('carol@example.com'),
  };
}

export const photo = async (token: string, name = 'IMG_1.JPG', date = '2024-05-04T10:00:00.000Z') =>
  (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(64)), { filename: name, fields: { fileCreatedAt: date } })).body.id;
