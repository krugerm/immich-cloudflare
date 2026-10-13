import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { expectResponse } from './contract';
import { authHeaders, BASE, createUser, login, uploadAsset } from './helpers';

async function setup() {
  await createUser();
  const token = await login();
  const { body } = await uploadAsset(token, crypto.getRandomValues(new Uint8Array(100)));
  return { token, id: body.id };
}

describe('asset viewer', () => {
  it('GET /assets/:id matches AssetResponseDto', async () => {
    const { token, id } = await setup();
    const res = await SELF.fetch(`${BASE}/api/assets/${id}`, { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expectResponse('/assets/{id}', 'get', 200, body);
    expect(body.id).toBe(id);
  });

  it('GET /assets/:id is 404 for another user', async () => {
    const { id } = await setup();
    await createUser({ email: 'other@example.com', isAdmin: false });
    const other = await login('other@example.com');
    const res = await SELF.fetch(`${BASE}/api/assets/${id}`, { headers: authHeaders(other) });
    expect(res.status).toBe(404);
  });

  it('stubs return empty arrays', async () => {
    const { token, id } = await setup();
    for (const path of [`/api/albums?assetId=${id}`, `/api/faces?id=${id}`, `/api/assets/${id}/ocr`]) {
      const res = await SELF.fetch(`${BASE}${path}`, { headers: authHeaders(token) });
      expect(res.status, path).toBe(200);
      expect(await res.json()).toEqual([]);
    }
  });

  it('phase 4 page stubs match the contract', async () => {
    const { token } = await setup();
    for (const path of [
      '/people',
      '/duplicates',
      '/system-metadata/admin-onboarding',
      '/system-metadata/version-check-state',
      '/system-metadata/reverse-geocoding-state',
    ]) {
      const res = await SELF.fetch(`${BASE}/api${path}`, { headers: authHeaders(token) });
      expect(res.status, path).toBe(200);
      expectResponse(path, 'get', 200, await res.json());
    }
    await createUser({ email: 'other@example.com', isAdmin: false });
    const other = await login('other@example.com');
    const res = await SELF.fetch(`${BASE}/api/system-metadata/version-check-state`, { headers: authHeaders(other) });
    expect(res.status).toBe(403);
  });

  it('web app stubs for memories and notifications match the contract', async () => {
    const { token } = await setup();
    const call = async (path: string) => {
      const res = await SELF.fetch(`${BASE}${path}`, { headers: authHeaders(token) });
      expect(res.status, path).toBe(200);
      return res.json();
    };
    for (const q of ['?for=2026-10-12&page=1', '?order=desc&page=1&size=250']) {
      const body = await call(`/api/memories${q}`);
      expectResponse('/memories', 'get', 200, body);
      expect(body).toEqual([]);
    }
    for (const q of ['?for=2026-10-12', '?order=desc&size=250']) {
      const body = await call(`/api/memories/statistics${q}`);
      expectResponse('/memories/statistics', 'get', 200, body);
      expect(body).toEqual({ total: 0 });
    }
    const notifications = await call('/api/notifications?unread=true');
    expectResponse('/notifications', 'get', 200, notifications);
    expect(notifications).toEqual([]);
  });

  it('GET /public/config is unauthenticated and matches PublicConfigDto', async () => {
    for (const path of ['/api/public/config', '/api/public/config/defaults']) {
      const res = await SELF.fetch(`${BASE}${path}`);
      expect(res.status, path).toBe(200);
      const body = await res.json();
      expectResponse(path.replace('/api', ''), 'get', 200, body);
      expect(body).toMatchObject({ passwordLogin: { enabled: true }, oauth: { enabled: false } });
    }
  });
});
