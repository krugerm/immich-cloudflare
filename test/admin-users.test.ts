import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { purgeDeletedUsers, USER_DELETE_DELAY_DAYS } from '../src/cron/purge-users';
import { runScheduled, DAILY_CRON } from '../src/cron';
import { expectResponse, expectSchema } from './contract';
import { BASE, login, uploadAsset } from './helpers';
import { call, syncLines, tok, twoUsers } from './stream-a-helpers';

const newUser = { email: 'Carol@Example.com', name: 'Carol', password: 'carol-pass-1' };

describe('admin users', () => {
  it('creates a user who can log in and appears in UserV1 sync', async () => {
    const { adminToken } = await twoUsers();
    const res = await call('POST', '/admin/users', tok(adminToken), {
      ...newUser,
      storageLabel: 'ca/rol',
      quotaSizeInBytes: 1000,
      shouldChangePassword: true,
      avatarColor: 'blue',
      pinCode: '123456',
      notify: true,
    });
    expect(res.status).toBe(201);
    expectResponse('/admin/users', 'post', 201, res.body);
    expect(res.body).toMatchObject({
      email: 'carol@example.com', name: 'Carol', isAdmin: false, storageLabel: 'carol', quotaSizeInBytes: 1000,
      shouldChangePassword: true, avatarColor: 'blue', status: 'active',
    });
    const carolToken = await login('carol@example.com', 'carol-pass-1');
    expect((await call('GET', '/auth/status', tok(carolToken))).body.pinCode).toBe(true);
    const lines = await syncLines(tok(adminToken), ['UsersV1']);
    const carol = lines.find((l) => l.type === 'UserV1' && l.data.id === res.body.id)!;
    expectSchema('SyncUserV1', carol.data);
  });

  it('validates input, duplicates and permissions', async () => {
    const { adminToken, bobToken } = await twoUsers();
    expect((await call('POST', '/admin/users', tok(bobToken), newUser)).status).toBe(403);
    expect((await call('POST', '/admin/users', tok(adminToken), { ...newUser, email: 'BOB@example.com' })).body.message).toBe('Email is not available');
    expect((await call('POST', '/admin/users', tok(adminToken), { ...newUser, email: 'nope' })).status).toBe(400);
    expect((await call('POST', '/admin/users', tok(adminToken), { email: 'x@y.z', name: 'X' })).status).toBe(400);
    expect((await call('POST', '/admin/users', tok(adminToken), { ...newUser, password: '' })).body.message).toBe('password is required');
    expect((await call('POST', '/admin/users', tok(adminToken), { ...newUser, quotaSizeInBytes: -1 })).status).toBe(400);
    expect((await call('POST', '/admin/users', tok(adminToken), { ...newUser, pinCode: '12' })).status).toBe(400);
    expect((await call('POST', '/admin/users', tok(adminToken), { ...newUser, storageLabel: 'admin' })).status).toBe(201);
    const other = await call('POST', '/admin/users', tok(adminToken), { email: 'd@example.com', name: 'D', password: 'p', storageLabel: 'admin' });
    expect(other.body.message).toBe('Storage label already in use by another account');
  });

  it('updates a user', async () => {
    const { bob, adminToken, bobToken } = await twoUsers();
    const res = await call('PUT', `/admin/users/${bob.id}`, tok(adminToken), {
      name: 'Robert', isAdmin: true, quotaSizeInBytes: null, storageLabel: '', password: 'new-bob-pass', shouldChangePassword: true,
    });
    expect(res.status).toBe(200);
    expectResponse('/admin/users/{id}', 'put', 200, res.body);
    expect(res.body).toMatchObject({ name: 'Robert', isAdmin: true, quotaSizeInBytes: null, storageLabel: null, shouldChangePassword: true });
    await login('bob@example.com', 'new-bob-pass');
    // Existing sessions survive an admin password reset, as in Immich.
    expect((await call('GET', '/users/me', tok(bobToken))).status).toBe(200);
    expect((await call('PUT', `/admin/users/${bob.id}`, tok(adminToken), { email: 'admin@example.com' })).status).toBe(400);
    expect((await call('PUT', `/admin/users/${crypto.randomUUID()}`, tok(adminToken), { name: 'x' })).body.message).toBe('User not found');
    expect((await call('PUT', `/admin/users/${bob.id}`, tok(bobToken), { name: 'x' })).status).toBe(200); // bob is admin now
  });

  it('an admin cannot change their own admin status', async () => {
    const { admin, adminToken } = await twoUsers();
    const res = await call('PUT', `/admin/users/${admin.id}`, tok(adminToken), { isAdmin: false });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Admin status can only be changed by another admin');
    expect((await call('PUT', `/admin/users/${admin.id}`, tok(adminToken), { isAdmin: true })).status).toBe(200);
  });

  it('updates preferences of another user', async () => {
    const { bob, adminToken, bobToken } = await twoUsers();
    const res = await call('PUT', `/admin/users/${bob.id}/preferences`, tok(adminToken), { folders: { enabled: true } });
    expect(res.status).toBe(200);
    expectResponse('/admin/users/{id}/preferences', 'put', 200, res.body);
    expect((await call('GET', '/users/me/preferences', tok(bobToken))).body.folders.enabled).toBe(true);
    expect((await call('PUT', `/admin/users/${bob.id}/preferences`, tok(bobToken), {})).status).toBe(403);
  });

  it('soft deletes, blocks the user, syncs deletedAt and restores', async () => {
    const { admin, bob, adminToken, bobToken } = await twoUsers();
    expect((await call('DELETE', `/admin/users/${admin.id}`, tok(adminToken), {})).body.message).toBe('Cannot delete your own account');
    expect((await call('DELETE', `/admin/users/${bob.id}`, tok(bobToken))).status).toBe(403);
    const del = await call('DELETE', `/admin/users/${bob.id}`, tok(adminToken));
    expect(del.status).toBe(200);
    expectResponse('/admin/users/{id}', 'delete', 200, del.body);
    expect(del.body.status).toBe('deleted');
    expect(del.body.deletedAt).not.toBeNull();
    expect((await call('GET', '/users/me', tok(bobToken))).status).toBe(401);
    expect((await call('DELETE', `/admin/users/${bob.id}`, tok(adminToken), {})).status).toBe(400);

    const lines = await syncLines(tok(adminToken), ['UsersV1']);
    expect(lines.find((l) => l.type === 'UserV1' && l.data.id === bob.id)!.data.deletedAt).not.toBeNull();

    const restored = await call('POST', `/admin/users/${bob.id}/restore`, tok(adminToken));
    expect(restored.status).toBe(200);
    expectResponse('/admin/users/{id}/restore', 'post', 200, restored.body);
    expect(restored.body).toMatchObject({ status: 'active', deletedAt: null });
    expect((await call('GET', '/users/me', tok(bobToken))).status).toBe(200);
    expect((await call('POST', `/admin/users/${crypto.randomUUID()}/restore`, tok(adminToken))).status).toBe(400);
  });

  it('force-deleted users are hard-deleted by the daily cron with their assets, sessions and keys', async () => {
    const { admin, bob, adminToken, bobToken } = await twoUsers();
    const upload = await uploadAsset(bobToken, new Uint8Array([1, 2, 3, 9]), { filename: 'b.jpg' });
    const assetId = upload.body.id;
    await call('POST', '/api-keys', tok(bobToken), { permissions: ['all'] });
    const form = new FormData();
    form.append('file', new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], 'p.jpg'));
    await SELF.fetch(`${BASE}/api/users/profile-image`, { method: 'POST', headers: tok(bobToken), body: form });
    const original = (await env.DB.prepare('SELECT original_path FROM assets WHERE id = ?1').bind(assetId).first<string>('original_path'))!;

    const del = await call('DELETE', `/admin/users/${bob.id}`, tok(adminToken), { force: true });
    expect(del.body.status).toBe('removing');
    await runScheduled(DAILY_CRON, env);

    expect(await env.DB.prepare('SELECT 1 FROM users WHERE id = ?1').bind(bob.id).first()).toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM assets WHERE id = ?1').bind(assetId).first()).toBeNull();
    expect(await env.DB.prepare('SELECT count(*) AS n FROM sessions WHERE user_id = ?1').bind(bob.id).first<number>('n')).toBe(0);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM api_keys WHERE user_id = ?1').bind(bob.id).first<number>('n')).toBe(0);
    expect(await env.MEDIA.head(original)).toBeNull();
    expect(await env.MEDIA.head(`profile/${bob.id}.jpeg`)).toBeNull();
    const audit = await env.DB.prepare('SELECT * FROM asset_audit WHERE asset_id = ?1').bind(assetId).first();
    expect(audit).not.toBeNull();

    const lines = await syncLines(tok(adminToken), ['UsersV1']);
    const gone = lines.find((l) => l.type === 'UserDeleteV1')!;
    expectSchema('SyncUserDeleteV1', gone.data);
    expect(gone.data.userId).toBe(bob.id);
    expect(lines.some((l) => l.type === 'UserV1' && l.data.id === admin.id)).toBe(true);
  });

  it('plain soft deletes wait for the delay; restored users are never purged', async () => {
    const { bob, adminToken } = await twoUsers();
    await call('DELETE', `/admin/users/${bob.id}`, tok(adminToken), {});
    expect(await purgeDeletedUsers(env)).toBe(0);
    const later = new Date(Date.now() + (USER_DELETE_DELAY_DAYS + 1) * 86_400_000);
    await call('POST', `/admin/users/${bob.id}/restore`, tok(adminToken));
    expect(await purgeDeletedUsers(env, later)).toBe(0);
    await call('DELETE', `/admin/users/${bob.id}`, tok(adminToken), {});
    expect(await purgeDeletedUsers(env, later)).toBe(1);
    expect(await env.DB.prepare('SELECT 1 FROM users WHERE id = ?1').bind(bob.id).first()).toBeNull();
  });

  it('purges large asset sets across runs', async () => {
    const { bob, adminToken, bobToken } = await twoUsers();
    for (let i = 0; i < 3; i++) await uploadAsset(bobToken, new Uint8Array([i, 7, 7]), { filename: `f${i}.jpg` });
    await call('DELETE', `/admin/users/${bob.id}`, tok(adminToken), { force: true });
    expect(await purgeDeletedUsers(env, new Date(), 2)).toBe(0);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM assets WHERE owner_id = ?1').bind(bob.id).first<number>('n')).toBe(1);
    expect(await purgeDeletedUsers(env, new Date(), 2)).toBe(1);
  });
});
