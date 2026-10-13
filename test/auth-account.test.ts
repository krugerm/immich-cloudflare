import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { findSession } from '../src/auth/session';
import { expectResponse, expectSchema } from './contract';
import { login } from './helpers';
import { call, key, syncLines, tok, twoUsers } from './stream-a-helpers';

describe('change password', () => {
  it('checks the current password, changes it and deletes the other sessions', async () => {
    const { adminToken } = await twoUsers();
    const other = await login();
    const wrong = await call('POST', '/auth/change-password', tok(adminToken), { password: 'nope', newPassword: 'new-secret-1' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.message).toBe('Wrong password');
    const res = await call('POST', '/auth/change-password', tok(adminToken), { password: 'secret-pass-1', newPassword: 'new-secret-1' });
    expect(res.status).toBe(200);
    expectResponse('/auth/change-password', 'post', 200, res.body);
    expect((await call('GET', '/users/me', tok(adminToken))).status).toBe(200);
    expect((await call('GET', '/users/me', tok(other))).status).toBe(401);
    await expect(login('admin@example.com', 'secret-pass-1')).rejects.toThrow();
    await login('admin@example.com', 'new-secret-1');
  });

  it('validates the body', async () => {
    const { adminToken } = await twoUsers();
    expect((await call('POST', '/auth/change-password', tok(adminToken), { password: 'secret-pass-1', newPassword: 'short' })).status).toBe(400);
    expect((await call('POST', '/auth/change-password', tok(adminToken), { password: 'secret-pass-1' })).status).toBe(400);
    expect((await call('POST', '/auth/change-password', {}, { password: 'a', newPassword: 'abcdefgh' })).status).toBe(401);
  });
});

describe('PIN code and session lock', () => {
  it('sets up, changes and resets a PIN code', async () => {
    const { admin, adminToken } = await twoUsers();
    let status = await call('GET', '/auth/status', tok(adminToken));
    expectResponse('/auth/status', 'get', 200, status.body);
    expect(status.body).toEqual({ pinCode: false, password: true, isElevated: false });

    expect((await call('POST', '/auth/pin-code', tok(adminToken), { pinCode: '12345' })).status).toBe(400);
    expect((await call('POST', '/auth/pin-code', tok(adminToken), { pinCode: '123456' })).status).toBe(204);
    const stored = await env.DB.prepare('SELECT pin_code FROM users WHERE id = ?1').bind(admin.id).first<string>('pin_code');
    expect(stored).toMatch(/^pbkdf2-sha256\$/);
    expect((await call('POST', '/auth/pin-code', tok(adminToken), { pinCode: '654321' })).body.message).toBe('User already has a PIN code');
    expect((await call('GET', '/auth/status', tok(adminToken))).body.pinCode).toBe(true);

    const badChange = await call('PUT', '/auth/pin-code', tok(adminToken), { pinCode: '000000', newPinCode: '222222' });
    expect(badChange.status).toBe(400);
    expect(badChange.body.message).toBe('Wrong PIN code');
    expect((await call('PUT', '/auth/pin-code', tok(adminToken), { newPinCode: '222222' })).body.message).toBe(
      'Either password or pinCode is required',
    );
    expect((await call('PUT', '/auth/pin-code', tok(adminToken), { pinCode: '123456', newPinCode: '222222' })).status).toBe(204);
    expect((await call('PUT', '/auth/pin-code', tok(adminToken), { password: 'secret-pass-1', newPinCode: '333333' })).status).toBe(204);

    expect((await call('DELETE', '/auth/pin-code', tok(adminToken), { password: 'wrong' })).status).toBe(400);
    expect((await call('DELETE', '/auth/pin-code', tok(adminToken), { pinCode: '333333' })).status).toBe(204);
    expect((await call('GET', '/auth/status', tok(adminToken))).body.pinCode).toBe(false);
    expect((await call('DELETE', '/auth/pin-code', tok(adminToken), { pinCode: '333333' })).body.message).toBe('User does not have a PIN code');
  });

  it('unlocks the session with the PIN and locks it again', async () => {
    const { adminToken } = await twoUsers();
    await call('POST', '/auth/pin-code', tok(adminToken), { pinCode: '123456' });
    expect((await call('POST', '/auth/session/unlock', tok(adminToken), { pinCode: '111111' })).status).toBe(400);
    expect((await call('POST', '/auth/session/unlock', tok(adminToken), { pinCode: '123456' })).status).toBe(204);
    const status = await call('GET', '/auth/status', tok(adminToken));
    expectResponse('/auth/status', 'get', 200, status.body);
    expect(status.body.isElevated).toBe(true);
    expect(Date.parse(status.body.pinExpiresAt) - Date.now()).toBeGreaterThan(14 * 60_000);
    expect((await findSession(env.DB, adminToken))!.hasElevatedPermission).toBe(true);

    expect((await call('POST', '/auth/session/lock', tok(adminToken))).status).toBe(204);
    expect((await call('GET', '/auth/status', tok(adminToken))).body.isElevated).toBe(false);
  });

  it('extends an unlock that is about to lapse and drops an expired one', async () => {
    const { adminToken } = await twoUsers();
    const session = (await findSession(env.DB, adminToken))!.session;
    await env.DB.prepare('UPDATE sessions SET pin_expires_at = ?2 WHERE id = ?1').bind(session.id, new Date(Date.now() + 60_000).toISOString()).run();
    const auth = (await findSession(env.DB, adminToken))!;
    expect(auth.hasElevatedPermission).toBe(true);
    expect(Date.parse(auth.session.pin_expires_at!) - Date.now()).toBeGreaterThan(4 * 60_000);
    await env.DB.prepare('UPDATE sessions SET pin_expires_at = ?2 WHERE id = ?1').bind(session.id, new Date(Date.now() - 1000).toISOString()).run();
    expect((await findSession(env.DB, adminToken))!.hasElevatedPermission).toBe(false);
  });

  it('resetting the PIN locks every session of the user', async () => {
    const { adminToken } = await twoUsers();
    const second = await login();
    await call('POST', '/auth/pin-code', tok(adminToken), { pinCode: '123456' });
    await call('POST', '/auth/session/unlock', tok(second), { pinCode: '123456' });
    expect((await call('GET', '/auth/status', tok(second))).body.isElevated).toBe(true);
    await call('DELETE', '/auth/pin-code', tok(adminToken), { password: 'secret-pass-1' });
    expect((await call('GET', '/auth/status', tok(second))).body.isElevated).toBe(false);
  });

  it('lock and unlock need a session token', async () => {
    const { adminToken } = await twoUsers();
    const k = (await call('POST', '/api-keys', tok(adminToken), { permissions: ['all'] })).body.secret;
    const res = await call('POST', '/auth/session/lock', key(k));
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('This endpoint can only be used with a session token');
    expect((await call('POST', '/auth/session/unlock', key(k), { pinCode: '123456' })).status).toBe(400);
  });

  it('the PIN hash reaches AuthUserV2 sync', async () => {
    const { adminToken } = await twoUsers();
    await call('POST', '/auth/pin-code', tok(adminToken), { pinCode: '123456' });
    const lines = await syncLines(tok(adminToken), ['AuthUsersV2']);
    const authUser = lines.find((l) => l.type === 'AuthUserV2')!;
    expectSchema('SyncAuthUserV2', authUser.data);
    expect(authUser.data.pinCode).toMatch(/^pbkdf2-sha256\$/);
  });
});
