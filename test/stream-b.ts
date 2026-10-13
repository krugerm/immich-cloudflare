import { SELF } from 'cloudflare:test';
import { expect } from 'vitest';
import { authHeaders, BASE, createUser, login, uploadAsset } from './helpers';

export async function call(token: string, method: string, path: string, body?: unknown) {
  const res = await SELF.fetch(`${BASE}/api${path}`, {
    method,
    headers: { ...authHeaders(token), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

/** Two users; `n` uploaded assets for the first. */
export async function setupAssets(n = 1, opts: { second?: boolean } = {}) {
  await createUser();
  const token = await login();
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const { body } = await uploadAsset(token, crypto.getRandomValues(new Uint8Array(100 + i)), { filename: `IMG_${i}.JPG` });
    ids.push(body.id);
  }
  let other = '';
  if (opts.second) {
    await createUser({ email: 'other@example.com', isAdmin: false, name: 'Other' });
    other = await login('other@example.com');
  }
  return { token, ids, other };
}

export type Line = { type: string; data: Record<string, any>; ack: string };

export async function sync(token: string, types: string[]): Promise<Line[]> {
  const res = await SELF.fetch(`${BASE}/api/sync/stream`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify({ types }),
  });
  expect(res.status).toBe(200);
  return (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
