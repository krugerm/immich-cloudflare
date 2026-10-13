import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { expectResponse, expectSchema } from './contract';
import { BASE, login } from './helpers';
import { call, key, syncLines, tok, twoUsers } from './stream-a-helpers';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

async function uploadProfile(token: string, bytes: Uint8Array, name = 'me.jpg') {
  const form = new FormData();
  form.append('file', new File([bytes], name));
  const res = await SELF.fetch(`${BASE}/api/users/profile-image`, { method: 'POST', headers: tok(token), body: form });
  return { status: res.status, body: (await res.json()) as any };
}

describe('PUT /users/me', () => {
  it('updates name, email and avatar colour and syncs the change', async () => {
    const { admin, adminToken } = await twoUsers();
    const before = await syncLines(tok(adminToken), ['UsersV1']);
    const complete = before.at(-1)!.ack;
    await call('POST', '/sync/ack', tok(adminToken), { acks: [...before.filter((l) => l.type === 'UserV1').map((l) => l.ack), complete] });

    const res = await call('PUT', '/users/me', tok(adminToken), { name: 'Alice', email: 'Alice@Example.com', avatarColor: 'green' });
    expect(res.status).toBe(200);
    expectResponse('/users/me', 'put', 200, res.body);
    expect(res.body).toMatchObject({ id: admin.id, name: 'Alice', email: 'alice@example.com', avatarColor: 'green' });

    const lines = await syncLines(tok(adminToken), ['UsersV1']);
    const user = lines.find((l) => l.type === 'UserV1' && l.data.id === admin.id)!;
    expectSchema('SyncUserV1', user.data);
    expect(user.data).toMatchObject({ name: 'Alice', email: 'alice@example.com', avatarColor: 'green' });
  });

  it('rejects a taken email, a password and bad input', async () => {
    const { adminToken } = await twoUsers();
    const taken = await call('PUT', '/users/me', tok(adminToken), { email: 'bob@example.com' });
    expect(taken.status).toBe(400);
    expect(taken.body.message).toBe('Email is not available');
    expect((await call('PUT', '/users/me', tok(adminToken), { password: 'whatever-123' })).status).toBe(400);
    expect((await call('PUT', '/users/me', tok(adminToken), { email: 'not-an-email' })).status).toBe(400);
    expect((await call('PUT', '/users/me', tok(adminToken), { avatarColor: 'chartreuse' })).status).toBe(400);
    expect((await call('PUT', '/users/me', tok(adminToken), { name: 5 })).status).toBe(400);
    expect((await call('PUT', '/users/me', {}, { name: 'x' })).status).toBe(401);
  });

  it('accepts a new password from the forced change-password screen, only while shouldChangePassword is set', async () => {
    const { admin, adminToken } = await twoUsers();
    await env.DB.prepare('UPDATE users SET should_change_password = 1 WHERE id = ?1').bind(admin.id).run();
    const res = await call('PUT', '/users/me', tok(adminToken), { password: 'new-password-123' });
    expect(res.status).toBe(200);
    expectResponse('/users/me', 'put', 200, res.body);
    expect(res.body.shouldChangePassword).toBe(false);
    // The flag is cleared, so a second password change through this endpoint is refused again.
    expect((await call('PUT', '/users/me', tok(adminToken), { password: 'another-password-1' })).status).toBe(400);
    const login = await SELF.fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: admin.email, password: 'new-password-123' }),
    });
    expect(login.status).toBe(201);
  });

  it('refuses the forced password change through an API key and ends the other sessions', async () => {
    const { admin, adminToken } = await twoUsers();
    const other = await login(); // a second session for the same user
    const k = (await call('POST', '/api-keys', tok(adminToken), { name: 'k', permissions: ['all'] })).body as { secret: string };
    await env.DB.prepare('UPDATE users SET should_change_password = 1 WHERE id = ?1').bind(admin.id).run();

    expect((await call('PUT', '/users/me', key(k.secret), { password: 'via-api-key-123' })).status).toBe(400);
    expect((await call('PUT', '/users/me', tok(adminToken), { password: 'new-password-123' })).status).toBe(200);
    expect((await call('GET', '/users/me', tok(adminToken))).status).toBe(200);
    expect((await call('GET', '/users/me', tok(other))).status).toBe(401);
  });

  it('avatarColor null resets to the email-derived colour', async () => {
    const { adminToken } = await twoUsers();
    await call('PUT', '/users/me', tok(adminToken), { avatarColor: 'green' });
    const res = await call('PUT', '/users/me', tok(adminToken), { avatarColor: null });
    expect(res.status).toBe(200);
    expectResponse('/users/me', 'put', 200, res.body);
  });
});

describe('preferences', () => {
  it('merges an update, stores only non-default values and returns the full set', async () => {
    const { admin, adminToken } = await twoUsers();
    const res = await call('PUT', '/users/me/preferences', tok(adminToken), {
      memories: { enabled: false },
      download: { archiveSize: 1024 },
      avatar: { color: 'red' },
      bogus: { x: 1 },
    });
    expect(res.status).toBe(200);
    expectResponse('/users/me/preferences', 'put', 200, res.body);
    expect(res.body.memories).toEqual({ enabled: false, duration: 5, sidebarWeb: false });
    expect(res.body.download.archiveSize).toBe(1024);
    const stored = await env.DB.prepare('SELECT preferences FROM users WHERE id = ?1').bind(admin.id).first<string>('preferences');
    expect(JSON.parse(stored!)).toEqual({ memories: { enabled: false }, download: { archiveSize: 1024 } });

    const back = await call('PUT', '/users/me/preferences', tok(adminToken), { memories: { enabled: true } });
    expect(back.body.memories.enabled).toBe(true);
    const got = await call('GET', '/users/me/preferences', tok(adminToken));
    expect(got.body).toEqual(back.body);
    expect(JSON.parse((await env.DB.prepare('SELECT preferences FROM users WHERE id = ?1').bind(admin.id).first<string>('preferences'))!)).toEqual({
      download: { archiveSize: 1024 },
    });
  });

  it('rejects invalid values', async () => {
    const { adminToken } = await twoUsers();
    expect((await call('PUT', '/users/me/preferences', tok(adminToken), { memories: { duration: 0 } })).status).toBe(400);
    expect((await call('PUT', '/users/me/preferences', tok(adminToken), { albums: { defaultAssetOrder: 'sideways' } })).status).toBe(400);
    expect((await call('PUT', '/users/me/preferences', tok(adminToken), { people: { enabled: 'yes' } })).status).toBe(400);
  });
});

describe('license and onboarding', () => {
  const licenseKey = 'IMCL-ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ12-3456';

  it('stores, returns and deletes the license', async () => {
    const { adminToken } = await twoUsers();
    expect((await call('GET', '/users/me/license', tok(adminToken))).status).toBe(404);
    expect((await call('PUT', '/users/me/license', tok(adminToken), { licenseKey: 'IMXX-1', activationKey: 'a' })).status).toBe(400);
    const set = await call('PUT', '/users/me/license', tok(adminToken), { licenseKey, activationKey: 'activation' });
    expect(set.status).toBe(200);
    expectResponse('/users/me/license', 'put', 200, set.body);
    const got = await call('GET', '/users/me/license', tok(adminToken));
    expectResponse('/users/me/license', 'get', 200, got.body);
    expect(got.body).toEqual(set.body);
    const me = await call('GET', '/users/me', tok(adminToken));
    expectResponse('/users/me', 'get', 200, me.body);
    expect(me.body.license.licenseKey).toBe(licenseKey);
    expect((await call('DELETE', '/users/me/license', tok(adminToken))).status).toBe(204);
    expect((await call('GET', '/users/me/license', tok(adminToken))).status).toBe(404);
    expect((await call('GET', '/users/me', tok(adminToken))).body.license).toBeNull();
  });

  it('reads, sets and deletes onboarding', async () => {
    const { adminToken } = await twoUsers();
    const got = await call('GET', '/users/me/onboarding', tok(adminToken));
    expectResponse('/users/me/onboarding', 'get', 200, got.body);
    expect(got.body).toEqual({ isOnboarded: true });
    expect((await call('DELETE', '/users/me/onboarding', tok(adminToken))).status).toBe(204);
    expect((await call('GET', '/users/me/onboarding', tok(adminToken))).body).toEqual({ isOnboarded: false });
    const put = await call('PUT', '/users/me/onboarding', tok(adminToken), { isOnboarded: true });
    expectResponse('/users/me/onboarding', 'put', 200, put.body);
    expect((await call('GET', '/users/me/onboarding', tok(adminToken))).body).toEqual({ isOnboarded: true });
    expect((await call('PUT', '/users/me/onboarding', tok(adminToken), {})).status).toBe(400);
  });
});

describe('profile image', () => {
  it('uploads, serves, replaces and deletes the image; profileChangedAt and hasProfileImage sync', async () => {
    const { admin, adminToken, bobToken } = await twoUsers();
    const up = await uploadProfile(adminToken, JPEG);
    expect(up.status).toBe(201);
    expectResponse('/users/profile-image', 'post', 201, up.body);
    expect(up.body.userId).toBe(admin.id);
    expect(up.body.profileImagePath).toBe(`profile/${admin.id}.jpeg`);
    expect(up.body.profileChangedAt > admin.profile_changed_at).toBe(true);

    const img = await SELF.fetch(`${BASE}/api/users/${admin.id}/profile-image`, { headers: tok(bobToken) });
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/jpeg');
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(JPEG);

    const lines = await syncLines(tok(adminToken), ['AuthUsersV2', 'UsersV1']);
    const authUser = lines.find((l) => l.type === 'AuthUserV2')!;
    expectSchema('SyncAuthUserV2', authUser.data);
    expect(authUser.data.hasProfileImage).toBe(true);
    expect(authUser.data.profileChangedAt).toBe(up.body.profileChangedAt);

    const png = await uploadProfile(adminToken, PNG, 'x.png');
    expect(png.body.profileImagePath).toBe(`profile/${admin.id}.png`);
    expect(await env.MEDIA.head(`profile/${admin.id}.jpeg`)).toBeNull();

    expect((await call('DELETE', '/users/profile-image', tok(adminToken))).status).toBe(204);
    expect(await env.MEDIA.head(`profile/${admin.id}.png`)).toBeNull();
    expect((await call('GET', `/users/${admin.id}/profile-image`, tok(bobToken))).status).toBe(404);
    const gone = await call('DELETE', '/users/profile-image', tok(adminToken));
    expect(gone.status).toBe(400);
    expect(gone.body.message).toBe("Can't delete a missing profile Image");
    expect((await call('GET', '/users/me', tok(adminToken))).body.profileImagePath).toBe('');
  });

  it('rejects files that are not images and missing files', async () => {
    const { adminToken } = await twoUsers();
    expect((await uploadProfile(adminToken, new TextEncoder().encode('hello world'))).status).toBe(400);
    const res = await SELF.fetch(`${BASE}/api/users/profile-image`, { method: 'POST', headers: tok(adminToken), body: new FormData() });
    expect(res.status).toBe(400);
    expect((await call('GET', '/users/not-a-uuid/profile-image', tok(adminToken))).status).toBe(400);
  });
});

describe('GET /users/{id}', () => {
  it('returns another user, 400 for unknown or deleted users', async () => {
    const { bob, adminToken } = await twoUsers();
    const res = await call('GET', `/users/${bob.id}`, tok(adminToken));
    expect(res.status).toBe(200);
    expectResponse('/users/{id}', 'get', 200, res.body);
    expect(res.body.email).toBe('bob@example.com');
    expect((await call('GET', `/users/${crypto.randomUUID()}`, tok(adminToken))).status).toBe(400);
    await call('DELETE', `/admin/users/${bob.id}`, tok(adminToken), {});
    expect((await call('GET', `/users/${bob.id}`, tok(adminToken))).status).toBe(400);
    expect((await call('GET', '/users/me', tok(adminToken))).body.id).not.toBe(bob.id);
  });
});
