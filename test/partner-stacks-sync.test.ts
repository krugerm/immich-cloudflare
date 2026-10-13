import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { expectSchema } from './contract';
import { authHeaders, BASE, createUser, login, uploadAsset } from './helpers';

// Gate C2 (streams D + E): PartnerStacksV1 sends PartnerStackDeleteV1, PartnerStackBackfillV1 and PartnerStackV1
// (Immich sync.service.ts syncPartnerStackV1, sync.repository.ts PartnerStackSync).

type Line = { type: string; data: Record<string, unknown>; ack: string };

async function sync(token: string, types = ['PartnerStacksV1']): Promise<Line[]> {
  const res = await SELF.fetch(`${BASE}/api/sync/stream`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify({ types }),
  });
  expect(res.status).toBe(200);
  return (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const call = async (method: string, path: string, token: string, body?: unknown) => {
  const res = await SELF.fetch(`${BASE}/api${path}`, {
    method,
    headers: { ...authHeaders(token), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

/** Mimics the client: ack the last line of each run of same-type lines (SyncAckV1 lines carry their own ack). */
async function ackAll(token: string, lines: Line[]) {
  const acks: string[] = [];
  lines.forEach((l, i) => {
    if (l.type === 'SyncCompleteV1') return;
    if (i === lines.length - 1 || lines[i + 1].type !== l.type || l.type === 'SyncAckV1') acks.push(l.ack);
  });
  expect((await call('POST', '/sync/ack', token, { acks })).status).toBe(204);
}

const types = (lines: Line[]) => lines.map((l) => l.type);
const upload = async (token: string, n: number) =>
  (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(64 + n)), { filename: `s${n}.jpg` })).body.id as string;

async function setup() {
  const admin = await createUser();
  const bob = await createUser({ email: 'bob@example.com', name: 'Bob', isAdmin: false });
  await createUser({ email: 'carol@example.com', name: 'Carol', isAdmin: false });
  return { admin, bob, a: await login(), b: await login('bob@example.com'), c: await login('carol@example.com') };
}

async function stack(token: string, base: number) {
  const ids = [await upload(token, base), await upload(token, base + 1)];
  const res = await call('POST', '/stacks', token, { assetIds: ids });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

describe('partner stack sync', () => {
  it('sends a partner stack as PartnerStackV1 and its removal as PartnerStackDeleteV1; strangers get nothing', async () => {
    const { admin, bob, a, b, c } = await setup();
    await call('POST', '/partners', a, { sharedWithId: bob.id });
    const id = await stack(a, 1);

    let lines = await sync(b);
    expect(types(lines)).toEqual(['PartnerStackV1', 'SyncCompleteV1']);
    expectSchema('SyncStackV1', lines[0].data);
    expect(lines[0].data).toMatchObject({ id, ownerId: admin.id });
    expect(lines[0].ack).toMatch(/^PartnerStackV1\|00000000-0000-7000-8000-[0-9a-f]{12}$/);
    await ackAll(b, lines);
    expect(types(await sync(c))).toEqual(['SyncCompleteV1']);
    expect(types(await sync(a))).toEqual(['SyncCompleteV1']); // the sharer's own stacks come through StacksV1

    expect((await call('DELETE', `/stacks/${id}`, a)).status).toBe(204);
    lines = await sync(b);
    expect(types(lines)).toEqual(['PartnerStackDeleteV1', 'SyncCompleteV1']);
    expectSchema('SyncStackDeleteV1', lines[0].data);
    expect(lines[0].data).toEqual({ stackId: id });
  });

  it('backfills the stacks of a partner added after the client synced, then marks it complete', async () => {
    const { bob, a, b, c } = await setup();
    const old = await stack(a, 10); // older than bob's upsert checkpoint, so only the backfill can send it
    await call('POST', '/partners', c, { sharedWithId: bob.id });
    await stack(c, 1);
    await ackAll(b, await sync(b)); // carol's stack via PartnerStackV1; the backfill checkpoint is stored complete
    await call('POST', '/partners', a, { sharedWithId: bob.id });

    const lines = await sync(b);
    expect(types(lines)).toEqual(['PartnerStackBackfillV1', 'SyncAckV1', 'SyncCompleteV1']);
    expect(lines[0].data).toMatchObject({ id: old });
    expectSchema('SyncStackV1', lines[0].data);
    expect(lines[0].ack).toMatch(/^PartnerStackBackfillV1\|00000000-0000-7000-8000-[0-9a-f]{12}\|00000000-0000-7000-8000-[0-9a-f]{12}$/);
    expect(lines[1].ack).toMatch(/^PartnerStackBackfillV1\|00000000-0000-7000-8000-[0-9a-f]{12}\|complete$/);
    await ackAll(b, lines);
    expect(types(await sync(b))).toEqual(['SyncCompleteV1']);
  });
});
