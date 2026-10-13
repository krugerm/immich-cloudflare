import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { expectResponse, validate } from './contract';

describe('scaffold', () => {
  it('answers ping', async () => {
    const res = await SELF.fetch('https://immich.test/api/server/ping');
    expect(res.status).toBe(200);
    const body = await res.json();
    expectResponse('/server/ping', 'get', 200, body);
    expect(body).toEqual({ res: 'pong' });
  });

  it('returns Immich-shaped 404 for unknown API routes', async () => {
    const res = await SELF.fetch('https://immich.test/api/nope', { headers: { 'cf-ray': 'ray123' } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: 'Not found', error: 'Not Found', statusCode: 404, correlationId: 'ray123' });
  });

  it('validator rejects a UUIDv7 where Immich requires v4', () => {
    const errors = validate('SyncAssetDeleteV1', { assetId: '0192f0c4-7d2a-7c3e-8f00-123456789abc' });
    expect(errors.join()).toContain('does not match pattern');
  });
});
