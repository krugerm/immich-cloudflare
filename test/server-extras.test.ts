import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { licenseConfig } from '../src/server/extras';
import { expectResponse } from './contract';
import { authHeaders, BASE, createUser, login } from './helpers';

const call = async (token: string | null, method: string, path: string, body?: unknown) => {
  const res = await SELF.fetch(`${BASE}/api${path}`, {
    method,
    headers: { ...(token ? authHeaders(token) : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const b64 = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const LICENSE_KEY = 'IMSV-ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ12-3456';

async function useKeyPair() {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const spki = b64((await crypto.subtle.exportKey('spki', pair.publicKey)) as ArrayBuffer);
  licenseConfig.serverPublicKey = btoa(`-----BEGIN PUBLIC KEY-----\n${spki}\n-----END PUBLIC KEY-----\n`);
  return async (key: string) => b64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(key)));
}

describe('server extras', () => {
  it('license: 404 when unset, set with a valid activation key, read, delete', async () => {
    const original = licenseConfig.serverPublicKey;
    try {
      await createUser();
      const token = await login();
      expect((await call(token, 'GET', '/server/license')).status).toBe(404);
      const sign = await useKeyPair();
      const set = await call(token, 'PUT', '/server/license', { licenseKey: LICENSE_KEY, activationKey: await sign(LICENSE_KEY) });
      expect(set.status).toBe(200);
      expectResponse('/server/license', 'put', 200, set.body);
      const got = await call(token, 'GET', '/server/license');
      expect(got.status).toBe(200);
      expectResponse('/server/license', 'get', 200, got.body);
      expect(got.body.licenseKey).toBe(LICENSE_KEY);
      expect((await call(token, 'GET', '/server/about')).body.licensed).toBe(true);
      expect((await call(token, 'DELETE', '/server/license')).status).toBe(204);
      expect((await call(token, 'GET', '/server/license')).status).toBe(404);
      expect((await call(token, 'GET', '/server/about')).body.licensed).toBe(false);
    } finally {
      licenseConfig.serverPublicKey = original;
    }
  });

  it('license: rejects bad signatures, wrong prefix and malformed input', async () => {
    const original = licenseConfig.serverPublicKey;
    try {
      await createUser();
      const token = await login();
      const sign = await useKeyPair();
      const clKey = LICENSE_KEY.replace('IMSV', 'IMCL');
      const cases: Array<[unknown, number]> = [
        [{ licenseKey: LICENSE_KEY, activationKey: 'AAAA' }, 400],
        [{ licenseKey: LICENSE_KEY, activationKey: await sign('IMSV-OTHER-KEY') }, 400],
        [{ licenseKey: clKey, activationKey: await sign(clKey) }, 400],
        [{ licenseKey: 'nope', activationKey: 'x' }, 400],
        [{ licenseKey: LICENSE_KEY }, 400],
        [{}, 400],
        [[], 400],
      ];
      for (const [body, status] of cases) expect((await call(token, 'PUT', '/server/license', body)).status, JSON.stringify(body)).toBe(status);
      expect((await call(token, 'GET', '/server/license')).status).toBe(404);
    } finally {
      licenseConfig.serverPublicKey = original;
    }
  });

  it('license endpoints are admin only', async () => {
    await createUser();
    await createUser({ email: 'user@example.com', isAdmin: false });
    const user = await login('user@example.com');
    for (const m of ['GET', 'PUT', 'DELETE']) {
      expect((await call(user, m, '/server/license', m === 'PUT' ? { licenseKey: LICENSE_KEY, activationKey: 'x' } : undefined)).status, m).toBe(403);
    }
    expect((await call(null, 'GET', '/server/license')).status).toBe(401);
  });

  it('apk links point at the release for SERVER_VERSION', async () => {
    await createUser();
    const token = await login();
    const res = await call(token, 'GET', '/server/apk-links');
    expect(res.status).toBe(200);
    expectResponse('/server/apk-links', 'get', 200, res.body);
    expect(res.body.universal).toBe('https://github.com/immich-app/immich/releases/download/v3.3.0/app-release.apk');
    expect((await call(null, 'GET', '/server/apk-links')).status).toBe(401);
  });

  it('version check reports no newer release', async () => {
    await createUser();
    const token = await login();
    const res = await call(token, 'GET', '/server/version-check');
    expect(res.status).toBe(200);
    expectResponse('/server/version-check', 'get', 200, res.body);
    expect(res.body).toEqual({ checkedAt: null, releaseVersion: null });
    expect((await call(null, 'GET', '/server/version-check')).status).toBe(401);
  });

  it('statistics stay admin only', async () => {
    await createUser();
    await createUser({ email: 'user@example.com', isAdmin: false });
    const res = await call(await login(), 'GET', '/server/statistics');
    expectResponse('/server/statistics', 'get', 200, res.body);
    expect((await call(await login('user@example.com'), 'GET', '/server/statistics')).status).toBe(403);
  });
});
