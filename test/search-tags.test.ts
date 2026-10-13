import { describe, expect, it } from 'vitest';
import { expectResponse } from './contract';
import { createUser, login, uploadAsset } from './helpers';
import { call, tok } from './stream-a-helpers';
import sampleJpg from './fixtures/media/sample.jpg?arraybuffer';

// Gate G6 (streams E + G): search filters on tags (owner-scoped; a tag matches its descendants, as Immich's tag_closure).

/** Distinct bytes per upload so checksums differ. */
async function upload(token: string, n: number): Promise<string> {
  const bytes = new Uint8Array(sampleJpg.byteLength + 1);
  bytes.set(new Uint8Array(sampleJpg));
  bytes[bytes.length - 1] = n;
  return (await uploadAsset(token, bytes, { filename: `IMG_${n}.JPG` })).body.id as string;
}

async function setup() {
  await createUser({ email: 'u@example.com', isAdmin: false });
  await createUser({ email: 'o@example.com', isAdmin: false });
  const token = await login('u@example.com');
  const otherToken = await login('o@example.com');
  const [cat, dog, both, none] = [await upload(token, 1), await upload(token, 2), await upload(token, 3), await upload(token, 4)];
  const tag = async (t: string, body: object) => {
    const r = await call('POST', '/tags', tok(t), body);
    expect(r.status).toBe(201);
    return r.body.id as string;
  };
  const animals = await tag(token, { name: 'animals' });
  const cats = await tag(token, { name: 'cats', parentId: animals });
  const dogs = await tag(token, { name: 'dogs', parentId: animals });
  const assign = async (tagId: string, ids: string[]) => expect((await call('PUT', `/tags/${tagId}/assets`, tok(token), { ids })).status).toBe(200);
  await assign(cats, [cat, both]);
  await assign(dogs, [dog, both]);
  const otherTag = await tag(otherToken, { name: 'animals' });
  return { token, otherToken, ids: { cat, dog, both, none }, tags: { animals, cats, dogs, otherTag } };
}

async function search(token: string, body: object): Promise<string[]> {
  const r = await call('POST', '/search/metadata', tok(token), body);
  expect(r.status).toBe(200);
  expectResponse('/search/metadata', 'post', 200, r.body);
  return (r.body.assets.items as Array<{ id: string }>).map((a) => a.id).sort();
}

const sorted = (...ids: string[]) => [...ids].sort();

describe('search by tag', () => {
  it('flat tagIds: every listed tag must match, a tag matches its descendants, null means untagged', async () => {
    const { token, ids, tags } = await setup();
    expect(await search(token, { tagIds: [tags.cats] })).toEqual(sorted(ids.cat, ids.both));
    expect(await search(token, { tagIds: [tags.animals] })).toEqual(sorted(ids.cat, ids.dog, ids.both));
    expect(await search(token, { tagIds: [tags.cats, tags.dogs] })).toEqual([ids.both]);
    expect(await search(token, { tagIds: null })).toEqual([ids.none]);
    expect(await search(token, { tagIds: [] })).toEqual(sorted(ids.cat, ids.dog, ids.both, ids.none));
  });

  it('structured tagIds any/all/none and hasTags', async () => {
    const { token, ids, tags } = await setup();
    const f = (filter: object) => search(token, { filter });
    expect(await f({ tagIds: { any: [tags.cats, tags.dogs] } })).toEqual(sorted(ids.cat, ids.dog, ids.both));
    expect(await f({ tagIds: { all: [tags.cats, tags.dogs] } })).toEqual([ids.both]);
    expect(await f({ tagIds: { all: [tags.cats, tags.cats] } })).toEqual(sorted(ids.cat, ids.both));
    expect(await f({ tagIds: { none: [tags.cats] } })).toEqual(sorted(ids.dog, ids.none));
    expect(await f({ tagIds: { any: [tags.animals], none: [tags.dogs] } })).toEqual([ids.cat]);
    expect(await f({ hasTags: { eq: true } })).toEqual(sorted(ids.cat, ids.dog, ids.both));
    expect(await f({ hasTags: { eq: false } })).toEqual([ids.none]);
    expect(await f({ or: [{ tagIds: { any: [tags.cats] } }, { hasTags: { eq: false } }] })).toEqual(sorted(ids.cat, ids.both, ids.none));
  });

  it('another user’s tag matches none of the caller’s assets', async () => {
    const { token, tags } = await setup();
    expect(await search(token, { tagIds: [tags.otherTag] })).toEqual([]);
    expect(await search(token, { filter: { tagIds: { any: [tags.otherTag] } } })).toEqual([]);
  });

  it('rejects malformed tag ids with 400', async () => {
    const { token } = await setup();
    expect((await call('POST', '/search/metadata', tok(token), { tagIds: ['nope'] })).status).toBe(400);
    expect((await call('POST', '/search/metadata', tok(token), { filter: { tagIds: { any: ['nope'] } } })).status).toBe(400);
  });
});
