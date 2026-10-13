import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { purgeDeletedUsers, purgeExpiredSessions } from '../src/cron/purge-users';
import { emit } from '../src/realtime/emit';
import { createUser, login } from './helpers';
import { connect, open, type Client } from './realtime-helpers';
import { call, tok } from './stream-a-helpers';

// Gate G1 (streams A + H): every path that revokes a session or a user closes its realtime sockets,
// and the revoked token cannot open a new socket afterwards.

async function sessionIdOf(token: string): Promise<string> {
  const r = await call('GET', '/sessions', tok(token));
  return r.body.find((s: { current: boolean }) => s.current).id;
}

async function expectRefused(token: string) {
  const { res, client } = await open(tok(token));
  expect(res.status).toBe(101);
  expect((await client!.next())[0]).toBe('0');
  expect(await client!.next()).toBe('44{"message":"unauthorized"}');
  expect(await client!.waitClosed()).toBe(true);
}

/** The socket is closed (after on_session_delete when a session id is given) and the token cannot reconnect. */
async function expectRevoked(c: Client, token: string, sessionId?: string) {
  if (sessionId) expect(await c.next((f) => f.startsWith('42["on_session_delete"'))).toBe(`42["on_session_delete","${sessionId}"]`);
  expect(await c.next((f) => f === '41')).toBe('41');
  expect(await c.waitClosed()).toBe(true);
  await expectRefused(token);
}

async function expectAlive(c: Client, userId: string) {
  await emit(env, userId, 'on_config_update');
  expect(await c.next()).toBe('42["on_config_update"]');
  expect(c.closed).toBe(false);
  c.ws.close();
}

describe('realtime revocation', () => {
  it('change-password closes the other sessions’ sockets and keeps the caller’s', async () => {
    const user = await createUser({ email: 'u@example.com', isAdmin: false });
    const t1 = await login('u@example.com');
    const t2 = await login('u@example.com');
    const s2 = await sessionIdOf(t2);
    const c1 = await connect(tok(t1));
    const c2 = await connect(tok(t2));
    const r = await call('POST', '/auth/change-password', tok(t1), { password: 'secret-pass-1', newPassword: 'new-pass-123' });
    expect(r.status).toBe(200);
    await expectRevoked(c2, t2, s2);
    await expectAlive(c1, user.id);
  });

  it('DELETE /sessions closes every other session’s sockets', async () => {
    const user = await createUser({ email: 'u@example.com', isAdmin: false });
    const t1 = await login('u@example.com');
    const t2 = await login('u@example.com');
    const s2 = await sessionIdOf(t2);
    const c1 = await connect(tok(t1));
    const c2 = await connect(tok(t2));
    expect((await call('DELETE', '/sessions', tok(t1))).status).toBe(204);
    await expectRevoked(c2, t2, s2);
    await expectAlive(c1, user.id);
  });

  it('DELETE /sessions and change-password also close sessions removed by the parent cascade', async () => {
    const user = await createUser({ email: 'u@example.com', isAdmin: false });
    const t1 = await login('u@example.com');
    for (const revoke of [
      () => call('DELETE', '/sessions', tok(t1)),
      () => call('POST', '/auth/change-password', tok(t1), { password: 'secret-pass-1', newPassword: 'secret-pass-1' }),
    ]) {
      const t2 = await login('u@example.com');
      const child = await call('POST', '/sessions', tok(t2), {});
      const cChild = await connect(tok(child.body.token));
      const r = await revoke();
      expect(r.status).toBeLessThan(300);
      await expectRevoked(cChild, child.body.token, child.body.id);
    }
    await expectAlive(await connect(tok(t1)), user.id);
  });

  it('DELETE /sessions/:id closes that session’s sockets and its descendant sessions’ sockets', async () => {
    const user = await createUser({ email: 'u@example.com', isAdmin: false });
    const t1 = await login('u@example.com');
    const t2 = await login('u@example.com');
    const s2 = await sessionIdOf(t2);
    const child = await call('POST', '/sessions', tok(t2), {});
    expect(child.status).toBe(201);
    const grandchild = await call('POST', '/sessions', tok(child.body.token), {});
    expect(grandchild.status).toBe(201);
    const c1 = await connect(tok(t1));
    const c2 = await connect(tok(t2));
    const cChild = await connect(tok(child.body.token));
    const cGrandchild = await connect(tok(grandchild.body.token));
    expect((await call('DELETE', `/sessions/${s2}`, tok(t1))).status).toBe(204);
    await expectRevoked(c2, t2, s2);
    await expectRevoked(cChild, child.body.token, child.body.id);
    await expectRevoked(cGrandchild, grandchild.body.token, grandchild.body.id);
    await expectAlive(c1, user.id);
  });

  it('logout closes the session’s and its child session’s sockets', async () => {
    const user = await createUser({ email: 'u@example.com', isAdmin: false });
    const t1 = await login('u@example.com');
    const t2 = await login('u@example.com');
    const s2 = await sessionIdOf(t2);
    const child = await call('POST', '/sessions', tok(t2), {});
    const c1 = await connect(tok(t1));
    const c2 = await connect(tok(t2));
    const cChild = await connect(tok(child.body.token));
    expect((await call('POST', '/auth/logout', tok(t2))).status).toBe(200);
    await expectRevoked(c2, t2, s2);
    await expectRevoked(cChild, child.body.token, child.body.id);
    await expectAlive(c1, user.id);
  });

  it('DELETE /sessions/:id of another user’s session deletes and disconnects nothing', async () => {
    await createUser({ email: 'u@example.com', isAdmin: false });
    const other = await createUser({ email: 'o@example.com', isAdmin: false });
    const t1 = await login('u@example.com');
    const tOther = await login('o@example.com');
    const sOther = await sessionIdOf(tOther);
    const cOther = await connect(tok(tOther));
    expect((await call('DELETE', `/sessions/${sOther}`, tok(t1))).status).toBe(400);
    await expectAlive(cOther, other.id);
  });

  it('admin soft delete closes every socket of the user and refuses new ones', async () => {
    await createUser();
    const adminToken = await login();
    const bob = await createUser({ email: 'bob@example.com', isAdmin: false });
    const bobToken = await login('bob@example.com');
    const c = await connect(tok(bobToken));
    expect((await call('DELETE', `/admin/users/${bob.id}`, tok(adminToken), {})).status).toBe(200);
    await expectRevoked(c, bobToken);
    expect((await call('GET', '/users/me', tok(bobToken))).status).toBe(401);
  });

  it('the user purge closes every socket of a purged user', async () => {
    const bob = await createUser({ email: 'bob@example.com', isAdmin: false });
    const bobToken = await login('bob@example.com');
    const c = await connect(tok(bobToken));
    // Marked for removal behind the API's back, so the soft-delete path has not already closed the socket.
    await env.DB.prepare(`UPDATE users SET deleted_at = ?2, status = 'removing' WHERE id = ?1`).bind(bob.id, new Date().toISOString()).run();
    expect(await purgeDeletedUsers(env)).toBe(1);
    await expectRevoked(c, bobToken);
  });

  it('the expired-session cleanup closes the sockets of exactly the deleted sessions', async () => {
    const user = await createUser({ email: 'u@example.com', isAdmin: false });
    const parent = await login('u@example.com');
    const child = (await call('POST', '/sessions', tok(parent), { duration: 60 })).body;
    const cParent = await connect(tok(parent));
    const cChild = await connect(tok(child.token));
    expect(await purgeExpiredSessions(env, new Date(Date.now() + 120_000))).toBe(1);
    await expectRevoked(cChild, child.token, child.id);
    await expectAlive(cParent, user.id);
  });
});
