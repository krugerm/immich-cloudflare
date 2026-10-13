import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { expectResponse } from './contract';
import { BASE } from './helpers';
import { call, tok, twoUsers } from './stream-a-helpers';

describe('OAuth (disabled)', () => {
  it('authorize, callback and link report that OAuth is not enabled', async () => {
    const { adminToken } = await twoUsers();
    for (const [path, headers] of [
      ['/oauth/authorize', {}],
      ['/oauth/callback', {}],
      ['/oauth/link', tok(adminToken)],
    ] as const) {
      const res = await call('POST', path, headers, { url: 'app.immich:///oauth-callback?code=1', redirectUri: 'x' });
      expect(res.status, path).toBe(400);
      expect(res.body.message).toBe('OAuth is not enabled');
    }
    expect((await call('POST', '/oauth/link', {}, {})).status).toBe(401);
    const bc = await SELF.fetch(`${BASE}/api/oauth/backchannel-logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'logout_token=x',
    });
    expect(bc.status).toBe(400);
  });

  it('unlink returns the user; unlink-all is admin-only', async () => {
    const { adminToken, bobToken } = await twoUsers();
    const res = await call('POST', '/oauth/unlink', tok(bobToken));
    expect(res.status).toBe(200);
    expectResponse('/oauth/unlink', 'post', 200, res.body);
    expect(res.body.oauthId).toBe('');
    expect((await call('POST', '/admin/auth/unlink-all', tok(bobToken))).status).toBe(403);
    expect((await call('POST', '/admin/auth/unlink-all', tok(adminToken))).status).toBe(204);
  });

  it('mobile-redirect forwards the query to the app scheme', async () => {
    const res = await SELF.fetch(`${BASE}/api/oauth/mobile-redirect?code=abc&state=xyz`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('app.immich:///oauth-callback?code=abc&state=xyz');
  });
});
