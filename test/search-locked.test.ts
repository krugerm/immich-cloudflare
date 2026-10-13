import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { authHeaders, BASE, createUser, login, uploadAsset } from './helpers';

// Gate C3 (streams A + G): Immich searchMetadata / searchStatistics / searchRandom / searchLargeAssets require an
// elevated session for visibility=locked, and with an elevated session and no visibility filter include locked assets.
// Search here is owner-only, so the locked assets found are always the caller's own.

async function post(token: string, path: string, body?: unknown) {
  const res = await SELF.fetch(`${BASE}/api${path}`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function setup() {
  await createUser();
  const other = await createUser({ email: 'bob@example.com', name: 'Bob', isAdmin: false });
  const token = await login();
  const bob = await login('bob@example.com');
  const open = (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(64)), { filename: 'open.jpg' })).body.id as string;
  const secret = (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(65)), { filename: 'secret.jpg' })).body.id as string;
  const bobSecret = (await uploadAsset(bob, crypto.getRandomValues(new Uint8Array(66)), { filename: 'bob.jpg' })).body.id as string;
  await env.DB.prepare("UPDATE assets SET visibility = 'locked' WHERE id IN (?1, ?2)").bind(secret, bobSecret).run();
  expect(other.id).toBeTruthy();
  return { token, open, secret, bobSecret };
}

async function elevate(token: string) {
  expect((await post(token, '/auth/pin-code', { pinCode: '123456' })).status).toBe(204);
  expect((await post(token, '/auth/session/unlock', { pinCode: '123456' })).status).toBe(204);
}

const ids = (r: { body: any }) => (r.body.assets.items as Array<{ id: string }>).map((a) => a.id).sort();

describe('search and locked assets', () => {
  it('without elevation: locked filters are 401 and locked assets are never returned', async () => {
    const { token, open } = await setup();
    expect((await post(token, '/search/metadata', { visibility: 'locked' })).status).toBe(401);
    expect((await post(token, '/search/metadata', { filter: { visibility: { eq: 'locked' } } })).status).toBe(401);
    expect((await post(token, '/search/statistics', { visibility: 'locked' })).status).toBe(401);
    expect(ids(await post(token, '/search/metadata', {}))).toEqual([open]);
  });

  it('elevated: the owner finds own locked assets, by filter or with no visibility filter', async () => {
    const { token, open, secret } = await setup();
    await elevate(token);
    expect(ids(await post(token, '/search/metadata', { visibility: 'locked' }))).toEqual([secret]);
    expect(ids(await post(token, '/search/metadata', { filter: { visibility: { eq: 'locked' } } }))).toEqual([secret]);
    expect(ids(await post(token, '/search/metadata', {}))).toEqual([open, secret].sort());
    expect(ids(await post(token, '/search/metadata', { filter: {} }))).toEqual([open, secret].sort());
    expect((await post(token, '/search/statistics', { visibility: 'locked' })).body).toEqual({ total: 1 });
    const random = await post(token, '/search/random', { visibility: 'locked' });
    expect(random.body.map((a: { id: string }) => a.id)).toEqual([secret]);
    // large-assets joins exif with a file size; the test uploads are not processed, so seed one
    await env.DB.prepare("INSERT INTO asset_exif (asset_id, owner_id, file_size_in_byte, update_id) SELECT id, owner_id, 1000, 'x' FROM assets WHERE id = ?1")
      .bind(secret)
      .run();
    const large = await post(token, '/search/large-assets?visibility=locked');
    expect(large.status).toBe(200);
    expect(large.body.map((a: { id: string }) => a.id)).toEqual([secret]);
  });
});
