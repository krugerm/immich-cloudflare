import { describe, expect, it } from 'vitest';
import { call, photo, twoUsers } from './album-helpers';
import { expectResponse } from './contract';

describe('activities', () => {
  it('members comment and like; duplicates return the existing like with 200', async () => {
    const { a, b, c, bob } = await twoUsers();
    const p = await photo(a);
    const albumId = (await call(a, 'POST', '/albums', { albumName: 'x', assetIds: [p], albumUsers: [{ userId: bob.id, role: 'viewer' }] })).body.id;

    const comment = await call(b, 'POST', '/activities', { albumId, type: 'comment', comment: 'nice' });
    expect(comment.status).toBe(201);
    expectResponse('/activities', 'post', 201, comment.body);
    expect(comment.body).toMatchObject({ type: 'comment', comment: 'nice', assetId: null });
    expect(comment.body.user.email).toBe('bob@example.com');

    const like = await call(b, 'POST', '/activities', { albumId, assetId: p, type: 'like' });
    expect(like.status).toBe(201);
    const again = await call(b, 'POST', '/activities', { albumId, assetId: p, type: 'like' });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(like.body.id);
    expect((await call(a, 'POST', '/activities', { albumId, type: 'like' })).status).toBe(201);

    const all = await call(a, 'GET', `/activities?albumId=${albumId}`);
    expectResponse('/activities', 'get', 200, all.body);
    expect(all.body.map((x: any) => x.type)).toEqual(['comment', 'like', 'like']);
    expect((await call(a, 'GET', `/activities?albumId=${albumId}&level=album`)).body).toHaveLength(2);
    expect((await call(a, 'GET', `/activities?albumId=${albumId}&assetId=${p}`)).body).toHaveLength(1);
    expect((await call(a, 'GET', `/activities?albumId=${albumId}&type=comment`)).body).toHaveLength(1);
    expect((await call(a, 'GET', `/activities?albumId=${albumId}&userId=${bob.id}`)).body).toHaveLength(2);

    const stats = await call(b, 'GET', `/activities/statistics?albumId=${albumId}`);
    expectResponse('/activities/statistics', 'get', 200, stats.body);
    expect(stats.body).toEqual({ comments: 1, likes: 2 });
    expect((await call(b, 'GET', `/activities/statistics?albumId=${albumId}&assetId=${p}`)).body).toEqual({ comments: 0, likes: 1 });

    expect((await call(c, 'GET', `/activities?albumId=${albumId}`)).status).toBe(400);
    expect((await call(c, 'POST', '/activities', { albumId, type: 'like' })).body.message).toBe('Not found or no activity.create access');
  });

  it('validates input and disabled activity', async () => {
    const { a } = await twoUsers();
    const p = await photo(a);
    const other = await photo(a, 'o.jpg');
    const albumId = (await call(a, 'POST', '/albums', { albumName: 'x', assetIds: [p] })).body.id;
    expect((await call(a, 'POST', '/activities', { albumId, type: 'comment' })).status).toBe(400);
    expect((await call(a, 'POST', '/activities', { albumId, type: 'like', comment: 'x' })).status).toBe(400);
    expect((await call(a, 'POST', '/activities', { albumId, type: 'shout' })).status).toBe(400);
    expect((await call(a, 'POST', '/activities', { albumId, assetId: other, type: 'like' })).status).toBe(400);
    expect((await call(a, 'GET', '/activities')).status).toBe(400);
    await call(a, 'PATCH', `/albums/${albumId}`, { isActivityEnabled: false });
    expect((await call(a, 'POST', '/activities', { albumId, type: 'like' })).status).toBe(400);
  });

  it('authors and album owners delete; others cannot; removing the asset drops its activity', async () => {
    const { a, b, c, bob, carol } = await twoUsers();
    const p = await photo(a);
    const albumId = (
      await call(a, 'POST', '/albums', {
        albumName: 'x',
        assetIds: [p],
        albumUsers: [
          { userId: bob.id, role: 'editor' },
          { userId: carol.id, role: 'editor' },
        ],
      })
    ).body.id;
    const byBob = (await call(b, 'POST', '/activities', { albumId, type: 'comment', comment: 'one' })).body.id;
    const byBob2 = (await call(b, 'POST', '/activities', { albumId, type: 'comment', comment: 'two' })).body.id;
    expect((await call(c, 'DELETE', `/activities/${byBob}`)).status).toBe(400);
    expect((await call(b, 'DELETE', `/activities/${byBob}`)).status).toBe(204);
    expect((await call(a, 'DELETE', `/activities/${byBob2}`)).status).toBe(204);

    await call(b, 'POST', '/activities', { albumId, assetId: p, type: 'like' });
    await call(a, 'DELETE', `/albums/${albumId}/assets`, { ids: [p] });
    expect((await call(a, 'GET', `/activities?albumId=${albumId}`)).body).toEqual([]);
  });
});
