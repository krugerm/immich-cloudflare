import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { findSession } from '../src/auth/session';
import { expectResponse } from './contract';
import { login } from './helpers';
import { call, key, syncLines, tok, twoUsers } from './stream-a-helpers';

const sessionId = async (token: string) => (await findSession(env.DB, token))!.session.id;

describe('sessions', () => {
  it('deletes one session and its sync checkpoints', async () => {
    const { adminToken } = await twoUsers();
    const other = await login();
    const otherId = await sessionId(other);
    await env.DB.prepare(`INSERT INTO sync_checkpoints (session_id, entity_type, ack) VALUES (?1, 'AssetV2', 'x')`).bind(otherId).run();
    expect((await call('DELETE', `/sessions/${otherId}`, tok(adminToken))).status).toBe(204);
    expect((await call('GET', '/users/me', tok(other))).status).toBe(401);
    const left = await env.DB.prepare('SELECT count(*) AS n FROM sync_checkpoints WHERE session_id = ?1').bind(otherId).first<number>('n');
    expect(left).toBe(0);
  });

  it("cannot touch another user's session", async () => {
    const { adminToken, bobToken } = await twoUsers();
    const bobSession = await sessionId(bobToken);
    const res = await call('DELETE', `/sessions/${bobSession}`, tok(adminToken));
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Not found or no authDevice.delete access');
    expect((await call('PUT', `/sessions/${bobSession}`, tok(adminToken), { isPendingSyncReset: true })).status).toBe(400);
    expect((await call('POST', `/sessions/${bobSession}/lock`, tok(adminToken))).status).toBe(400);
    expect((await call('GET', '/users/me', tok(bobToken))).status).toBe(200);
    expect((await call('DELETE', '/sessions/nope', tok(adminToken))).status).toBe(400);
  });

  it('deletes all other sessions but keeps the current one and other users', async () => {
    const { adminToken, bobToken } = await twoUsers();
    const a2 = await login();
    const a3 = await login();
    expect((await call('DELETE', '/sessions', tok(adminToken))).status).toBe(204);
    expect((await call('GET', '/users/me', tok(adminToken))).status).toBe(200);
    expect((await call('GET', '/users/me', tok(a2))).status).toBe(401);
    expect((await call('GET', '/users/me', tok(a3))).status).toBe(401);
    expect((await call('GET', '/users/me', tok(bobToken))).status).toBe(200);
  });

  it('isPendingSyncReset makes the next stream a reset, and acking the reset clears it', async () => {
    const { adminToken } = await twoUsers();
    const id = await sessionId(adminToken);
    expect((await call('PUT', `/sessions/${id}`, tok(adminToken), {})).body.message).toBe('No fields to update');
    const res = await call('PUT', `/sessions/${id}`, tok(adminToken), { isPendingSyncReset: true });
    expect(res.status).toBe(200);
    expectResponse('/sessions/{id}', 'put', 200, res.body);
    expect(res.body.isPendingSyncReset).toBe(true);
    const listed = (await call('GET', '/sessions', tok(adminToken))).body.find((s: { id: string }) => s.id === id);
    expect(listed.isPendingSyncReset).toBe(true);

    const lines = await syncLines(tok(adminToken), ['AuthUsersV2']);
    expect(lines.map((l) => l.type)).toEqual(['SyncResetV1']);
    expect((await call('POST', '/sync/ack', tok(adminToken), { acks: ['SyncResetV1|reset'] })).status).toBe(204);
    const after = await syncLines(tok(adminToken), ['AuthUsersV2']);
    expect(after.map((l) => l.type)).toEqual(['AuthUserV2', 'SyncCompleteV1']);
  });

  it('a stream with reset: true clears a pending reset', async () => {
    const { adminToken } = await twoUsers();
    const id = await sessionId(adminToken);
    await call('PUT', `/sessions/${id}`, tok(adminToken), { isPendingSyncReset: true });
    const res = await call('POST', '/sync/stream', tok(adminToken), { types: ['AuthUsersV2'], reset: true });
    expect(res.status).toBe(200);
    expect(String(res.body)).toContain('AuthUserV2');
  });

  it('locks a session', async () => {
    const { adminToken } = await twoUsers();
    const other = await login();
    await call('POST', '/auth/pin-code', tok(adminToken), { pinCode: '123456' });
    await call('POST', '/auth/session/unlock', tok(other), { pinCode: '123456' });
    expect((await call('POST', `/sessions/${await sessionId(other)}/lock`, tok(adminToken))).status).toBe(204);
    expect((await call('GET', '/auth/status', tok(other))).body.isElevated).toBe(false);
  });

  it('creates a child session that expires and goes with its parent', async () => {
    const { adminToken } = await twoUsers();
    const res = await call('POST', '/sessions', tok(adminToken), { deviceType: 'Cast', deviceOS: 'Chromecast', duration: 60 });
    expect(res.status).toBe(201);
    expectResponse('/sessions', 'post', 201, res.body);
    expect(res.body).toMatchObject({ deviceType: 'Cast', deviceOS: 'Chromecast', current: false });
    expect(Date.parse(res.body.expiresAt)).toBeGreaterThan(Date.now());
    const child = res.body.token as string;
    expect((await call('GET', '/users/me', tok(child))).status).toBe(200);

    await env.DB.prepare('UPDATE sessions SET expires_at = ?2 WHERE id = ?1').bind(res.body.id, new Date(Date.now() - 1000).toISOString()).run();
    expect((await call('GET', '/users/me', tok(child))).status).toBe(401);
    const ids = (await call('GET', '/sessions', tok(adminToken))).body.map((s: { id: string }) => s.id);
    expect(ids).not.toContain(res.body.id);

    const second = (await call('POST', '/sessions', tok(adminToken), {})).body.token as string;
    expect((await call('POST', '/auth/logout', tok(adminToken))).status).toBe(200);
    expect((await call('GET', '/users/me', tok(second))).status).toBe(401);
  });

  it('creating a session needs a session token; bad input is 400', async () => {
    const { adminToken } = await twoUsers();
    const k = (await call('POST', '/api-keys', tok(adminToken), { permissions: ['all'] })).body.secret;
    expect((await call('POST', '/sessions', key(k), {})).status).toBe(400);
    expect((await call('POST', '/sessions', tok(adminToken), { duration: 0 })).status).toBe(400);
    expect((await call('POST', '/sessions', tok(adminToken), { duration: 'x' })).status).toBe(400);
  });

  it('with an API key, delete-all removes every session and the list has no current one', async () => {
    const { adminToken } = await twoUsers();
    const k = (await call('POST', '/api-keys', tok(adminToken), { permissions: ['all'] })).body.secret;
    const list = await call('GET', '/sessions', key(k));
    expect(list.body.filter((s: { current: boolean }) => s.current)).toEqual([]);
    expect((await call('DELETE', '/sessions', key(k))).status).toBe(204);
    expect((await call('GET', '/users/me', tok(adminToken))).status).toBe(401);
  });
});
