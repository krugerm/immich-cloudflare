import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createUser, login, uploadAsset } from './helpers';
import { call, tok } from './stream-a-helpers';
import sampleJpg from './fixtures/media/sample.jpg?arraybuffer';

// Gate G2 (streams A + B + D): locked assets are usable only by their owner from a PIN-elevated session; partners never.

async function setup() {
  await createUser({ email: 'owner@example.com', isAdmin: false });
  const partner = await createUser({ email: 'partner@example.com', isAdmin: false });
  const ownerToken = await login('owner@example.com');
  const partnerToken = await login('partner@example.com');
  const id = (await uploadAsset(ownerToken, new Uint8Array(sampleJpg))).body.id as string;
  expect((await call('POST', '/partners', tok(ownerToken), { sharedWithId: partner.id })).status).toBe(201);
  return { ownerToken, partnerToken, id };
}

async function elevate(token: string) {
  expect((await call('POST', '/auth/pin-code', tok(token), { pinCode: '123456' })).status).toBe(204);
  expect((await call('POST', '/auth/session/unlock', tok(token), { pinCode: '123456' })).status).toBe(204);
}

const lock = (id: string) => env.DB.prepare("UPDATE assets SET visibility = 'locked' WHERE id = ?1").bind(id).run();
const visibility = async (id: string) =>
  (await env.DB.prepare('SELECT visibility FROM assets WHERE id = ?1').bind(id).first<{ visibility: string }>())!.visibility;

describe('locked assets', () => {
  it('without elevation: moving into the locked folder is 403 and a locked asset reads as missing', async () => {
    const { ownerToken, id } = await setup();
    expect((await call('PUT', `/assets/${id}`, tok(ownerToken), { visibility: 'locked' })).status).toBe(403);
    expect(await visibility(id)).toBe('timeline');
    await lock(id);
    expect((await call('GET', `/assets/${id}`, tok(ownerToken))).status).toBe(404);
    expect((await call('GET', `/assets/${id}/original`, tok(ownerToken))).status).toBe(404);
    expect((await call('PUT', `/assets/${id}`, tok(ownerToken), { visibility: 'timeline' })).status).toBe(400);
    expect((await call('GET', '/timeline/buckets?visibility=locked', tok(ownerToken))).status).toBe(401);
    expect((await call('GET', '/assets/statistics?visibility=locked', tok(ownerToken))).status).toBe(401);
  });

  it('an elevated owner moves assets in and out of the locked folder and reads them', async () => {
    const { ownerToken, id } = await setup();
    await elevate(ownerToken);
    const put = await call('PUT', `/assets/${id}`, tok(ownerToken), { visibility: 'locked' });
    expect(put.status).toBe(200);
    expect(await visibility(id)).toBe('locked');
    expect((await call('GET', `/assets/${id}`, tok(ownerToken))).body.visibility).toBe('locked');
    expect((await call('GET', `/assets/${id}/original`, tok(ownerToken))).status).toBe(200);
    const buckets = await call('GET', '/timeline/buckets?visibility=locked', tok(ownerToken));
    expect(buckets.status).toBe(200);
    expect(buckets.body.reduce((n: number, b: { count: number }) => n + b.count, 0)).toBe(1);
    expect((await call('GET', '/assets/statistics?visibility=locked', tok(ownerToken))).body.total).toBe(1);
    const info = await call('POST', '/download/info', tok(ownerToken), { assetIds: [id] });
    expect(info.status).toBe(201);
    expect(info.body.totalSize).toBeGreaterThan(0);
    expect((await call('PUT', '/assets', tok(ownerToken), { ids: [id], visibility: 'timeline' })).status).toBe(204);
    expect(await visibility(id)).toBe('timeline');
  });

  it('locking the session again hides the locked asset', async () => {
    const { ownerToken, id } = await setup();
    await elevate(ownerToken);
    await lock(id);
    expect((await call('GET', `/assets/${id}`, tok(ownerToken))).status).toBe(200);
    expect((await call('POST', '/auth/session/lock', tok(ownerToken))).status).toBe(204);
    expect((await call('GET', `/assets/${id}`, tok(ownerToken))).status).toBe(404);
  });

  it('a partner never reads a locked asset, even from an elevated session', async () => {
    const { partnerToken, id } = await setup();
    expect((await call('GET', `/assets/${id}`, tok(partnerToken))).status).toBe(200);
    await lock(id);
    await elevate(partnerToken);
    expect((await call('GET', `/assets/${id}`, tok(partnerToken))).status).toBe(404);
    expect((await call('GET', `/assets/${id}/original`, tok(partnerToken))).status).toBe(404);
  });
});
