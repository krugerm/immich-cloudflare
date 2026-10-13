import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { purgeDeletedUsers } from '../src/cron/purge-users';
import { authHeaders, BASE, createUser, login, uploadAsset } from './helpers';

// Final review item 6: the user purge dissolves the user's stacks with a stack_audit row, so partners get
// PartnerStackDeleteV1 (and the owner's devices StackDeleteV1) instead of a silent cascade.

type Line = { type: string; data: Record<string, unknown>; ack: string };

const call = async (method: string, path: string, token: string, body?: unknown) => {
  const res = await SELF.fetch(`${BASE}/api${path}`, {
    method,
    headers: { ...authHeaders(token), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

async function sync(token: string): Promise<Line[]> {
  const res = await SELF.fetch(`${BASE}/api/sync/stream`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify({ types: ['PartnerStacksV1'] }),
  });
  return (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const upload = async (token: string, n: number) =>
  (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(64 + n)), { filename: `s${n}.jpg` })).body.id as string;

describe('user purge and stacks', () => {
  it('writes a stack audit for each stack of the purged user', async () => {
    await createUser();
    const bob = await createUser({ email: 'bob@example.com', name: 'Bob', isAdmin: false });
    const a = await login();
    const b = await login('bob@example.com');
    const admin = (await call('GET', '/users/me', a)).body;
    expect((await call('POST', '/partners', b, { sharedWithId: admin.id })).status).toBe(201);
    const stackRes = await call('POST', '/stacks', b, { assetIds: [await upload(b, 1), await upload(b, 2)] });
    expect(stackRes.status).toBe(201);
    const stackId = stackRes.body.id as string;
    await upload(b, 3);
    const lines = await sync(a);
    expect(lines.some((l) => l.type === 'PartnerStackV1' && l.data.id === stackId)).toBe(true);
    const acks = lines.filter((l) => l.type !== 'SyncCompleteV1').map((l) => l.ack);
    expect((await call('POST', '/sync/ack', a, { acks })).status).toBe(204);

    expect((await call('DELETE', `/admin/users/${bob.id}`, a, { force: true })).status).toBe(200);
    // A budget of exactly Bob's three assets deletes them all but stops before the final batch, so the partner row
    // (and with it the partner's view of Bob's stacks) is still there when the partner syncs.
    expect(await purgeDeletedUsers(env, new Date(), 3)).toBe(0);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM assets WHERE owner_id = ?1').bind(bob.id).first('n')).toBe(0);
    expect(await env.DB.prepare('SELECT 1 FROM stacks WHERE id = ?1').bind(stackId).first()).toBeNull();
    expect((await sync(a)).filter((l) => l.type === 'PartnerStackDeleteV1').map((l) => l.data)).toEqual([{ stackId }]);

    expect(await purgeDeletedUsers(env)).toBe(1);
    const audit = await env.DB.prepare('SELECT stack_id, owner_id FROM stack_audit').all();
    expect(audit.results).toEqual([{ stack_id: stackId, owner_id: bob.id }]);
  });
});
