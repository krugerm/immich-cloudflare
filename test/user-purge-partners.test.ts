import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { purgeDeletedUsers } from '../src/cron/purge-users';
import { expectSchema } from './contract';
import { createUser, login } from './helpers';
import { call, syncLines, tok } from './stream-a-helpers';

// Gate G3 (streams A + D): the user purge removes the user's partner rows on either side (with PartnerDeleteV1
// audit rows) and the user's notifications before deleting the user.

describe('user purge with partners and notifications', () => {
  it('hard-deletes a partnered user and syncs PartnerDeleteV1 to the other side', async () => {
    await createUser();
    const adminToken = await login();
    const bob = await createUser({ email: 'bob@example.com', isAdmin: false });
    const carol = await createUser({ email: 'carol@example.com', isAdmin: false });
    const bobToken = await login('bob@example.com');
    const carolToken = await login('carol@example.com');
    expect((await call('POST', '/partners', tok(bobToken), { sharedWithId: carol.id })).status).toBe(201);
    expect((await call('POST', '/partners', tok(carolToken), { sharedWithId: bob.id })).status).toBe(201);
    expect((await call('POST', '/admin/notifications', tok(adminToken), { userId: bob.id, title: 'hello' })).status).toBe(201);

    // Carol has synced both partner rows before the purge.
    const before = await syncLines(tok(carolToken), ['PartnersV1']);
    expect(before.filter((l) => l.type === 'PartnerV1')).toHaveLength(2);
    await call('POST', '/sync/ack', tok(carolToken), { acks: before.map((l) => l.ack) });

    expect((await call('DELETE', `/admin/users/${bob.id}`, tok(adminToken), { force: true })).status).toBe(200);
    expect(await purgeDeletedUsers(env)).toBe(1);

    expect(await env.DB.prepare('SELECT id FROM users WHERE id = ?1').bind(bob.id).first()).toBeNull();
    const left = await env.DB.prepare('SELECT count(*) AS n FROM partners WHERE shared_by_id = ?1 OR shared_with_id = ?1').bind(bob.id).first<{ n: number }>();
    expect(left!.n).toBe(0);
    const notes = await env.DB.prepare('SELECT count(*) AS n FROM notifications WHERE user_id = ?1').bind(bob.id).first<{ n: number }>();
    expect(notes!.n).toBe(0);

    const after = await syncLines(tok(carolToken), ['PartnersV1']);
    const deletes = after.filter((l) => l.type === 'PartnerDeleteV1');
    for (const d of deletes) expectSchema('SyncPartnerDeleteV1', d.data);
    expect(deletes.map((d) => [d.data.sharedById, d.data.sharedWithId]).sort()).toEqual(
      [
        [bob.id, carol.id],
        [carol.id, bob.id],
      ].sort(),
    );
    expect(after.filter((l) => l.type === 'PartnerV1')).toHaveLength(0);
  });
});
