import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { assetTypeFor, extensionOf } from '../src/upload/media-types';
import { expectResponse } from './contract';
import { authHeaders, BASE, createUser, login } from './helpers';

const get = (path: string, headers: Record<string, string> = {}) => SELF.fetch(`${BASE}${path}`, { headers });

describe('server endpoints', () => {
  it('serves .well-known/immich', async () => {
    expect(await (await get('/.well-known/immich')).json()).toEqual({ api: { endpoint: '/api' } });
  });

  it('reports version 3.3.0', async () => {
    const body = await (await get('/api/server/version')).json();
    expectResponse('/server/version', 'get', 200, body);
    expect(body).toEqual({ major: 3, minor: 3, patch: 0, prerelease: null });
  });

  it('features and config match the contract', async () => {
    const features = (await (await get('/api/server/features')).json()) as Record<string, boolean>;
    expectResponse('/server/features', 'get', 200, features);
    expect(features.passwordLogin).toBe(true);
    expect(features.smartSearch).toBe(true); // phase 4: ML_CONTAINER and the vector index are bound
    const config = (await (await get('/api/server/config')).json()) as Record<string, unknown>;
    expectResponse('/server/config', 'get', 200, config);
    expect(config.isInitialized).toBe(false);
    expect(config.isOnboarded).toBe(true);
    await createUser();
    expect(((await (await get('/api/server/config')).json()) as Record<string, unknown>).isInitialized).toBe(true);
  });

  it('about, version-history, media-types, storage match the contract', async () => {
    await createUser();
    const token = await login();
    expectResponse('/server/about', 'get', 200, await (await get('/api/server/about', authHeaders(token))).json());
    expect(await (await get('/api/server/version-history', authHeaders(token))).json()).toEqual([]);
    const media = await (await get('/api/server/media-types')).json();
    expectResponse('/server/media-types', 'get', 200, media);
    expect((media as { image: string[] }).image).toContain('.heic');
    expectResponse('/server/storage', 'get', 200, await (await get('/api/server/storage', authHeaders(token))).json());
  });

  it('users/me and preferences match the contract', async () => {
    await createUser();
    const token = await login();
    const me = await get('/api/users/me', authHeaders(token));
    expect(me.status).toBe(200);
    const body = (await me.json()) as { avatarColor: string };
    expectResponse('/users/me', 'get', 200, body);
    expect(body.avatarColor).toBe('gray'); // emailToAvatarColor('admin@example.com')
    const prefs = await get('/api/users/me/preferences', authHeaders(token));
    expectResponse('/users/me/preferences', 'get', 200, await prefs.json());
  });

  it('users/me derives the default avatar colour like Immich', async () => {
    // The reference server returned "blue" for ref@example.com (asset-response fixture).
    await createUser({ email: 'ref@example.com' });
    const token = await login('ref@example.com');
    const me = (await (await get('/api/users/me', authHeaders(token))).json()) as { avatarColor: string };
    expect(me.avatarColor).toBe('blue');
  });

  it('users/me requires auth', async () => {
    expect((await get('/api/users/me')).status).toBe(401);
  });
});

describe('media types', () => {
  it('classifies by extension', () => {
    expect(extensionOf('IMG_0001.HEIC')).toBe('.heic');
    expect(assetTypeFor('IMG_0001.HEIC')).toBe('IMAGE');
    expect(assetTypeFor('clip.MOV')).toBe('VIDEO');
    expect(assetTypeFor('notes.txt')).toBeNull();
  });
});

// Gate G5: trash is implemented (stream B), so /server/features follows the stored trash.enabled setting (Immich).
describe('server features: trash', () => {
  it('reports trash true by default and false when the admin disables it', async () => {
    expect(((await (await get('/api/server/features')).json()) as Record<string, boolean>).trash).toBe(true);
    await createUser();
    const token = await login();
    const config = (await (await get('/api/admin/config', authHeaders(token))).json()) as { trash: { enabled: boolean } };
    config.trash.enabled = false;
    const put = await SELF.fetch(`${BASE}/api/admin/config`, {
      method: 'PUT',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify(config),
    });
    expect(put.status).toBe(200);
    expect(((await (await get('/api/server/features')).json()) as Record<string, boolean>).trash).toBe(false);
  });
});
