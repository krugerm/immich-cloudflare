import { describe, expect, it } from 'vitest';
import { call, photo, twoUsers } from './album-helpers';

// Gate C5 (streams C + G): with albums merged, the album-membership filters on the caller's own assets match Immich
// (isNotInAlbum: not in any album; hasAlbums: in at least one album or none). Search stays owner-only: see the scope
// note in src/search/routes.ts.

const ids = (r: { body: any }) => (r.body.assets.items as Array<{ id: string }>).map((a) => a.id).sort();

describe('search album filters', () => {
  it('isNotInAlbum and hasAlbums', async () => {
    const { a } = await twoUsers();
    const inside = await photo(a, 'in.jpg');
    const outside = await photo(a, 'out.jpg');
    await call(a, 'POST', '/albums', { albumName: 'x', assetIds: [inside] });

    expect(ids(await call(a, 'POST', '/search/metadata', { isNotInAlbum: true }))).toEqual([outside]);
    expect(ids(await call(a, 'POST', '/search/metadata', { isNotInAlbum: false }))).toEqual([inside, outside].sort());
    expect(ids(await call(a, 'POST', '/search/metadata', { filter: { hasAlbums: { eq: true } } }))).toEqual([inside]);
    expect(ids(await call(a, 'POST', '/search/metadata', { filter: { hasAlbums: { eq: false } } }))).toEqual([outside]);
  });
});
