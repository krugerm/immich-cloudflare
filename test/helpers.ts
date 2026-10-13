import { env, SELF } from 'cloudflare:test';
import { insertUser } from '../src/users/repo';

export const BASE = 'https://immich.test';

export async function createUser(opts: { email?: string; password?: string; name?: string; isAdmin?: boolean } = {}) {
  return insertUser(env.DB, {
    email: opts.email ?? 'admin@example.com',
    password: opts.password ?? 'secret-pass-1',
    name: opts.name ?? 'Admin',
    isAdmin: opts.isAdmin ?? true,
  });
}

/** Each call uses a fresh client IP so the login rate limiter (shared across test files) never trips. */
export async function login(email = 'admin@example.com', password = 'secret-pass-1'): Promise<string> {
  const ip = `10.${[0, 0, 0].map(() => Math.floor(Math.random() * 250)).join('.')}`;
  const res = await SELF.fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 201) throw new Error(`login failed ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

export function authHeaders(token: string): Record<string, string> {
  return { 'x-immich-user-token': token };
}

export async function uploadAsset(
  token: string,
  bytes: Uint8Array,
  opts: { filename?: string; fields?: Record<string, string>; fieldsAfterFile?: Record<string, string> } = {},
) {
  const form = new FormData();
  const fields = {
    deviceAssetId: opts.filename ?? 'IMG_0001.JPG',
    deviceId: 'test-device',
    fileCreatedAt: '2024-05-04T10:00:00.000Z',
    fileModifiedAt: '2024-05-04T10:00:00.000Z',
    isFavorite: 'false',
    duration: '0',
    ...opts.fields,
  };
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append('assetData', new File([bytes], opts.filename ?? 'IMG_0001.JPG', { type: 'application/octet-stream' }));
  for (const [k, v] of Object.entries(opts.fieldsAfterFile ?? {})) form.append(k, v);
  const res = await SELF.fetch(`${BASE}/api/assets`, { method: 'POST', headers: authHeaders(token), body: form });
  return { status: res.status, body: (await res.json()) as { id: string; status: string } };
}
