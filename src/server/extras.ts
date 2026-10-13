// stream F: license, APK links and version check.
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { requireAdmin, requireAuth } from '../auth/session';
import { ImmichError } from '../http/errors';
import { bad, jsonObject } from '../http/validate';
import { deleteState, getState, setState } from './state';

export const serverExtraRoutes = new Hono<AppEnv>();

/** Immich's production license verification key (base64 of a PEM SPKI RSA key). Tests replace it. */
export const licenseConfig = {
  serverPublicKey:
    'LS0tLS1CRUdJTiBQVUJMSUMgS0VZLS0tLS0KTUlJQklqQU5CZ2txaGtpRzl3MEJBUUVGQUFPQ0FROEFNSUlCQ2dLQ0FRRUFvcG5ZRGEwYS9kVTVJZUc3NGlFRQpNd2RBS2pzTmN6TGRDcVJkMVo5eTVUMndqTzdlWUlPZUpUc2wzNTBzUjBwNEtmU1VEU1h2QzlOcERwYzF0T0tsCjVzaEMvQXhwdlFBTENva0Y0anQ4dnJyZDlmQ2FYYzFUcVJiT21uaGl1Z0Q2dmtyME8vRmIzVURpM1UwVHZoUFAKbFBkdlNhd3pMcldaUExmbUhWVnJiclNLbW45SWVTZ3kwN3VrV1RJeUxzY2lOcnZuQnl3c0phUmVEdW9OV1BCSApVL21vMm1YYThtNHdNV2hpWGVoaUlPUXFNdVNVZ1BlQ3NXajhVVngxQ0dsUnpQREEwYlZOUXZlS1hXVnhjRUk2ClVMRWdKeTJGNDlsSDArYVlDbUJmN05FcjZWUTJXQjk1ZXZUS1hLdm4wcUlNN25nRmxjVUF3NmZ1VjFjTkNUSlMKNndJREFRQUIKLS0tLS1FTkQgUFVCTElDIEtFWS0tLS0tDQo=',
};

const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));

async function verifyLicense(licenseKey: string, activationKey: string): Promise<boolean> {
  try {
    const pem = new TextDecoder().decode(b64ToBytes(licenseConfig.serverPublicKey));
    const der = b64ToBytes(pem.replace(/-----(BEGIN|END) PUBLIC KEY-----|\s/g, ''));
    const key = await crypto.subtle.importKey('spki', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64ToBytes(activationKey), new TextEncoder().encode(licenseKey));
  } catch {
    return false;
  }
}

interface License {
  licenseKey: string;
  activationKey: string;
  activatedAt: string;
}
export const LICENSE_KEY = 'license';

serverExtraRoutes.get('/server/license', requireAdmin, async (c) => {
  const license = await getState<License>(c.env.DB, LICENSE_KEY);
  if (!license) throw new ImmichError(404, 'Not Found');
  return c.json(license);
});

serverExtraRoutes.put('/server/license', requireAdmin, async (c) => {
  const body = await jsonObject(c.req.raw);
  const { licenseKey, activationKey } = body;
  if (typeof licenseKey !== 'string' || !/^IM(SV|CL)(-[\dA-Za-z]{4}){8}$/.test(licenseKey)) bad('licenseKey must match IMSV or IMCL format');
  if (typeof activationKey !== 'string') bad('activationKey must be a string');
  if (!(licenseKey as string).startsWith('IMSV-') || !(await verifyLicense(licenseKey as string, activationKey as string))) throw new ImmichError(400, 'Invalid license key');
  const license: License = { licenseKey: licenseKey as string, activationKey: activationKey as string, activatedAt: new Date().toISOString() };
  await setState(c.env.DB, LICENSE_KEY, license);
  return c.json(license);
});

serverExtraRoutes.delete('/server/license', requireAdmin, async (c) => {
  await deleteState(c.env.DB, LICENSE_KEY);
  return c.body(null, 204);
});

serverExtraRoutes.get('/server/apk-links', requireAuth, (c) => {
  const base = `https://github.com/immich-app/immich/releases/download/v${c.env.SERVER_VERSION}`;
  return c.json({
    arm64v8a: `${base}/app-arm64-v8a-release.apk`,
    armeabiv7a: `${base}/app-armeabi-v7a-release.apk`,
    universal: `${base}/app-release.apk`,
    x86_64: `${base}/app-x86_64-release.apk`,
  });
});

// No outbound calls: the server never learns of a newer release.
serverExtraRoutes.get('/server/version-check', requireAuth, (c) => c.json({ checkedAt: null, releaseVersion: null }));
