import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { purgeDeletedUsers } from '../src/cron/purge-users';
import { call, photo, twoUsers } from './album-helpers';
import { authHeaders, BASE } from './helpers';

// Final review item 2: the user purge deletes the user's own albums (members get AlbumDeleteV1, as DELETE /albums/:id)
// and removes the user from albums of others (remaining members get AlbumUserDeleteV1).

type Line = { type: string; data: Record<string, any>; ack: string };

async function sync(token: string): Promise<Line[]> {
  const res = await SELF.fetch(`${BASE}/api/sync/stream`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify({ types: ['AlbumsV2', 'AlbumUsersV1'] }),
  });
  return (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function syncAndAck(token: string) {
  const acks = (await sync(token)).filter((l) => l.type !== 'SyncCompleteV1').map((l) => l.ack);
  expect((await call(token, 'POST', '/sync/ack', { acks })).status).toBe(204);
}

describe('user purge and albums', () => {
  it('deletes owned albums and leaves shared ones with an audit for the remaining members', async () => {
    const { a, b, c, admin, bob, carol } = await twoUsers();
    const p = await photo(a, 'p.jpg');
    const x = (await call(a, 'POST', '/albums', { albumName: 'x', assetIds: [p], albumUsers: [{ userId: bob.id, role: 'editor' }] })).body.id;
    const y = (
      await call(b, 'POST', '/albums', {
        albumName: 'y',
        albumUsers: [
          { userId: carol.id, role: 'viewer' },
          { userId: admin.id, role: 'editor' },
        ],
      })
    ).body.id;
    await syncAndAck(a);
    await syncAndAck(c);

    expect((await call(a, 'DELETE', `/admin/users/${bob.id}`, { force: true })).status).toBe(200);
    expect(await purgeDeletedUsers(env)).toBe(1);

    expect(await env.DB.prepare('SELECT 1 FROM albums WHERE id = ?1').bind(y).first()).toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM albums WHERE id = ?1').bind(x).first()).not.toBeNull();

    const carolLines = await sync(c);
    expect(carolLines.filter((l) => l.type === 'AlbumDeleteV1').map((l) => l.data)).toEqual([{ albumId: y }]);

    const adminLines = await sync(a);
    expect(adminLines.filter((l) => l.type === 'AlbumDeleteV1').map((l) => l.data)).toEqual([{ albumId: y }]);
    expect(adminLines.filter((l) => l.type === 'AlbumUserDeleteV1').map((l) => l.data)).toEqual([{ albumId: x, userId: bob.id }]);
    expect((await call(a, 'GET', `/albums/${x}`)).body.albumUsers.map((u: { user: { id: string } }) => u.user.id)).toEqual([admin.id]);
  });
});
