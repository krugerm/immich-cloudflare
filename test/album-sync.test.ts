import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { findSession } from '../src/auth/session';
import { commit, tracked } from '../src/db/changes';
import { parseAck } from '../src/sync/acks';
import { streamSync } from '../src/sync/routes';
import { call, photo, twoUsers } from './album-helpers';
import { expectSchema } from './contract';
import { authHeaders, BASE } from './helpers';

type Line = { type: string; data: Record<string, any>; ack: string };

const TYPES = ['AuthUsersV2', 'UsersV1', 'AssetsV2', 'AlbumAssetsV2', 'AlbumsV2', 'AlbumUsersV1', 'AlbumToAssetsV1', 'AssetExifsV1', 'AlbumAssetExifsV1'];
const ALBUM_TYPES = ['AlbumAssetsV2', 'AlbumsV2', 'AlbumUsersV1', 'AlbumToAssetsV1', 'AlbumAssetExifsV1'];

async function sync(token: string, types = ALBUM_TYPES): Promise<Line[]> {
  const res = await SELF.fetch(`${BASE}/api/sync/stream`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify({ types }),
  });
  expect(res.status).toBe(200);
  return (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** Mimics the client: ack the last line of each run of same-type lines (SyncAckV1 lines carry their own ack). */
async function ackAll(token: string, lines: Line[]) {
  const acks: string[] = [];
  lines.forEach((l, i) => {
    if (l.type === 'SyncCompleteV1') return;
    if (i === lines.length - 1 || lines[i + 1].type !== l.type || l.type === 'SyncAckV1') acks.push(l.ack);
  });
  const res = await call(token, 'POST', '/sync/ack', { acks });
  expect(res.status).toBe(204);
}

const SCHEMA: Record<string, string> = {
  AlbumV2: 'SyncAlbumV2',
  AlbumDeleteV1: 'SyncAlbumDeleteV1',
  AlbumUserV1: 'SyncAlbumUserV1',
  AlbumUserBackfillV1: 'SyncAlbumUserV1',
  AlbumUserDeleteV1: 'SyncAlbumUserDeleteV1',
  AlbumToAssetV1: 'SyncAlbumToAssetV1',
  AlbumToAssetBackfillV1: 'SyncAlbumToAssetV1',
  AlbumToAssetDeleteV1: 'SyncAlbumToAssetDeleteV1',
  AlbumAssetCreateV2: 'SyncAssetV2',
  AlbumAssetUpdateV2: 'SyncAssetV2',
  AlbumAssetBackfillV2: 'SyncAssetV2',
  AlbumAssetExifCreateV1: 'SyncAssetExifV1',
  AlbumAssetExifUpdateV1: 'SyncAssetExifV1',
  AlbumAssetExifBackfillV1: 'SyncAssetExifV1',
  SyncAckV1: 'SyncAckV1',
};
const checkSchemas = (lines: Line[]) => lines.forEach((l) => SCHEMA[l.type] && expectSchema(SCHEMA[l.type], l.data));
const types = (lines: Line[]) => lines.map((l) => l.type);

async function addExif(assetId: string, ownerId: string) {
  await commit(env.DB, [tracked("INSERT INTO asset_exif (asset_id, owner_id, city, update_id) VALUES (?1, ?2, 'Bern', :cursor)", assetId, ownerId)]);
}

describe('album sync', () => {
  it('first sync sends albums, members, album assets and exif in Immich order', async () => {
    const { a, b, admin, bob } = await twoUsers();
    const p = await photo(a);
    await addExif(p, admin.id);
    await env.DB.prepare('UPDATE assets SET is_favorite = 1 WHERE id = ?1').bind(p).run();
    const albumId = (await call(a, 'POST', '/albums', { albumName: 'Trip', assetIds: [p], albumUsers: [{ userId: bob.id, role: 'viewer' }] })).body.id;

    const lines = await sync(b, TYPES);
    checkSchemas(lines);
    expect(types(lines)).toEqual([
      'AuthUserV2',
      'UserV1',
      'UserV1',
      'UserV1',
      'SyncAckV1',
      'AlbumAssetCreateV2',
      'AlbumV2',
      'AlbumUserV1',
      'AlbumUserV1',
      'AlbumToAssetV1',
      'SyncAckV1',
      'AlbumAssetExifCreateV1',
      'SyncCompleteV1',
    ]);
    const byType = (t: string) => lines.filter((l) => l.type === t);
    expect(byType('SyncAckV1')[0].ack).toMatch(/^AlbumAssetUpdateV2\|00000000-0000-7000-8000-[0-9a-f]{12}$/);
    expect(byType('SyncAckV1')[1].ack).toMatch(/^AlbumAssetExifUpdateV1\|/);
    expect(byType('AlbumAssetCreateV2')[0].data).toMatchObject({ id: p, ownerId: admin.id, isFavorite: false });
    expect(byType('AlbumV2')[0].data).toMatchObject({ id: albumId, name: 'Trip', description: '', thumbnailAssetId: p, order: 'desc' });
    expect(byType('AlbumUserV1').map((l) => [l.data.userId, l.data.role]).sort()).toEqual([[admin.id, 'owner'], [bob.id, 'viewer']].sort());
    expect(byType('AlbumToAssetV1')[0].data).toEqual({ albumId, assetId: p });
    expect(byType('AlbumAssetExifCreateV1')[0].data).toMatchObject({ assetId: p, city: 'Bern' });

    // the owner sees their own favourite flag
    const own = await sync(a);
    expect(own.find((l) => l.type === 'AlbumAssetCreateV2')!.data.isFavorite).toBe(true);

    await ackAll(b, lines);
    expect(types(await sync(b, TYPES))).toEqual(['SyncCompleteV1']);
  });

  it('changes to known album assets arrive as updates; new album assets as creates', async () => {
    const { a, b, admin, bob } = await twoUsers();
    const p1 = await photo(a);
    const albumId = (await call(a, 'POST', '/albums', { albumName: 'x', assetIds: [p1], albumUsers: [{ userId: bob.id, role: 'viewer' }] })).body.id;
    await ackAll(b, await sync(b));

    await commit(env.DB, [tracked("UPDATE assets SET original_file_name = 'renamed.jpg', update_id = :cursor WHERE id = ?1", p1)]);
    await addExif(p1, admin.id);
    let lines = await sync(b);
    checkSchemas(lines);
    // the asset had no EXIF when first synced, so its EXIF arrives as a create (as in Immich)
    expect(types(lines)).toEqual(['AlbumAssetUpdateV2', 'SyncAckV1', 'AlbumAssetExifCreateV1', 'SyncCompleteV1']);
    expect(lines[0].data.originalFileName).toBe('renamed.jpg');
    await ackAll(b, lines);
    await commit(env.DB, [tracked("UPDATE asset_exif SET city = 'Thun', update_id = :cursor WHERE asset_id = ?1", p1)]);
    lines = await sync(b);
    expect(types(lines)).toEqual(['AlbumAssetExifUpdateV1', 'SyncCompleteV1']);
    expect(lines[0].data.city).toBe('Thun');
    await ackAll(b, lines);

    const p2 = await photo(a, 'two.jpg');
    await call(a, 'PUT', `/albums/${albumId}/assets`, { ids: [p2] });
    lines = await sync(b);
    expect(types(lines)).toEqual(['SyncAckV1', 'AlbumAssetCreateV2', 'AlbumV2', 'AlbumToAssetV1', 'SyncCompleteV1']);
    expect(lines[1].data.id).toBe(p2);
  });

  it('a member added to an older album gets it by backfill, acked with three-part acks', async () => {
    const { a, c, carol, admin } = await twoUsers();
    const old = await photo(a, 'old.jpg');
    await addExif(old, admin.id);
    const older = (await call(a, 'POST', '/albums', { albumName: 'older', assetIds: [old] })).body.id;
    // Carol already syncs another album, so she has create checkpoints past the older album's rows
    const p = await photo(a, 'p.jpg');
    await addExif(p, admin.id);
    await call(a, 'POST', '/albums', { albumName: 'first', assetIds: [p], albumUsers: [{ userId: carol.id, role: 'viewer' }] });
    await ackAll(c, await sync(c));

    await call(a, 'PUT', `/albums/${older}/users`, { albumUsers: [{ userId: carol.id, role: 'viewer' }] });
    const lines = await sync(c);
    checkSchemas(lines);
    expect(types(lines)).toEqual([
      'AlbumAssetBackfillV2',
      'SyncAckV1',
      'AlbumV2',
      'AlbumUserBackfillV1',
      'SyncAckV1',
      'AlbumUserV1',
      'AlbumToAssetBackfillV1',
      'SyncAckV1',
      'AlbumAssetExifBackfillV1',
      'SyncAckV1',
      'SyncCompleteV1',
    ]);
    const createId = lines[0].ack.split('|')[1];
    expect(lines[0].ack).toMatch(/^AlbumAssetBackfillV2\|00000000-0000-7000-8000-[0-9a-f]{12}\|00000000-0000-7000-8000-[0-9a-f]{12}$/);
    expect(lines[0].data.id).toBe(old);
    expect(lines[1].ack).toBe(`AlbumAssetBackfillV2|${createId}|complete`);
    expect(lines[2].data.id).toBe(older);
    expect(lines[3].data).toMatchObject({ albumId: older, userId: admin.id, role: 'owner' });
    expect(lines[5].data).toMatchObject({ albumId: older, userId: carol.id, role: 'viewer' });
    expect(lines[6].data).toEqual({ albumId: older, assetId: old });
    expect(lines[8].data.assetId).toBe(old);

    await ackAll(c, lines);
    const stored = await env.DB.prepare("SELECT ack FROM sync_checkpoints WHERE entity_type = 'AlbumAssetBackfillV2'").first<{ ack: string }>();
    expect(stored!.ack).toBe(`AlbumAssetBackfillV2|${createId}|complete`);
    expect(types(await sync(c))).toEqual(['SyncCompleteV1']);
  });

  it('removals: asset from album, member from album, album deletion', async () => {
    const { a, b, admin, bob } = await twoUsers();
    const p = await photo(a);
    const albumId = (await call(a, 'POST', '/albums', { albumName: 'x', assetIds: [p], albumUsers: [{ userId: bob.id, role: 'viewer' }] })).body.id;
    await ackAll(a, await sync(a));
    await ackAll(b, await sync(b));

    await call(a, 'DELETE', `/albums/${albumId}/assets`, { ids: [p] });
    let lines = await sync(b);
    checkSchemas(lines);
    expect(types(lines)).toEqual(['AlbumV2', 'AlbumToAssetDeleteV1', 'SyncCompleteV1']); // thumbnail repair bumps the album
    expect(lines[1].data).toEqual({ albumId, assetId: p });
    await ackAll(b, lines);

    await call(a, 'DELETE', `/albums/${albumId}/user/${bob.id}`);
    lines = await sync(b);
    expect(types(lines)).toEqual(['AlbumDeleteV1', 'SyncCompleteV1']);
    expect(lines[0].data).toEqual({ albumId });
    lines = await sync(a);
    checkSchemas(lines);
    expect(lines.filter((l) => l.type === 'AlbumUserDeleteV1').map((l) => l.data)).toEqual([{ albumId, userId: bob.id }]);
    await ackAll(a, lines);

    await call(a, 'DELETE', `/albums/${albumId}`);
    lines = await sync(a);
    expect(types(lines)).toEqual(['AlbumDeleteV1', 'SyncCompleteV1']);
    expect(admin.id).toBeTruthy();
  });

  it('stops within the query budget mid-backfill and resumes from the acks', async () => {
    const { a, c, carol } = await twoUsers();
    const olds: string[] = [];
    for (let i = 0; i < 5; i++) olds.push(await photo(a, `o${i}.jpg`));
    const older = (await call(a, 'POST', '/albums', { albumName: 'older', assetIds: olds })).body.id;
    const p = await photo(a, 'p.jpg');
    await call(a, 'POST', '/albums', { albumName: 'first', assetIds: [p], albumUsers: [{ userId: carol.id, role: 'viewer' }] });
    await ackAll(c, await sync(c));
    await call(a, 'PUT', `/albums/${older}/users`, { albumUsers: [{ userId: carol.id }] });

    const auth = (await findSession(env.DB, c))!;
    const read = async (budget: number) => {
      const text = await new Response(streamSync(env.DB, auth, ['AlbumAssetsV2'], { pageSize: 2, queryBudget: budget })).text();
      return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Line);
    };
    const partial = await read(4); // 2 setup + album list + one page of 2
    expect(types(partial)).toEqual(['AlbumAssetBackfillV2', 'AlbumAssetBackfillV2']);
    await ackAll(c, partial);
    const rest = await read(950);
    expect(rest.filter((l) => l.type === 'AlbumAssetBackfillV2').map((l) => l.data.id).sort()).toEqual(
      olds.filter((id) => !partial.some((l) => l.data.id === id)).sort(),
    );
    expect(types(rest).at(-1)).toBe('SyncCompleteV1');
  });

  it('a non-member gets no lines for the album, its users, assets or exif', async () => {
    const { a, c, admin, bob } = await twoUsers();
    const p = await photo(a);
    await addExif(p, admin.id);
    const albumId = (await call(a, 'POST', '/albums', { albumName: 'private', assetIds: [p], albumUsers: [{ userId: bob.id, role: 'editor' }] })).body.id;
    await call(a, 'DELETE', `/albums/${albumId}/user/${bob.id}`); // audit rows exist too
    await call(a, 'PUT', `/albums/${albumId}/users`, { albumUsers: [{ userId: bob.id }] });
    await call(a, 'DELETE', `/albums/${albumId}/assets`, { ids: [p] });

    const lines = await sync(c, TYPES);
    expect(types(lines)).toEqual(['AuthUserV2', 'UserV1', 'UserV1', 'UserV1', 'SyncCompleteV1']);
    const text = JSON.stringify(lines);
    expect(text).not.toContain(albumId);
    expect(text).not.toContain(p);
  });

  it('a removed member gets AlbumDeleteV1 and nothing about the album afterwards', async () => {
    const { a, b, admin, bob } = await twoUsers();
    const p = await photo(a);
    await addExif(p, admin.id);
    const albumId = (await call(a, 'POST', '/albums', { albumName: 'x', assetIds: [p], albumUsers: [{ userId: bob.id, role: 'viewer' }] })).body.id;
    await ackAll(b, await sync(b));

    await call(a, 'DELETE', `/albums/${albumId}/user/${bob.id}`);
    let lines = await sync(b);
    expect(lines.map((l) => [l.type, l.data])).toEqual([
      ['AlbumDeleteV1', { albumId }],
      ['SyncCompleteV1', {}],
    ]);
    await ackAll(b, lines);

    // further changes to the album, its users, assets and exif do not reach the removed member
    const p2 = await photo(a, 'two.jpg');
    await call(a, 'PUT', `/albums/${albumId}/assets`, { ids: [p2] });
    await call(a, 'PATCH', `/albums/${albumId}`, { albumName: 'renamed' });
    await commit(env.DB, [tracked("UPDATE asset_exif SET city = 'Thun', update_id = :cursor WHERE asset_id = ?1", p)]);
    await commit(env.DB, [tracked("UPDATE assets SET original_file_name = 'r.jpg', update_id = :cursor WHERE id = ?1", p)]);
    await call(a, 'DELETE', `/albums/${albumId}/assets`, { ids: [p] });
    lines = await sync(b);
    expect(types(lines)).toEqual(['SyncCompleteV1']);
  });

  it('never sends another owner’s locked asset; album asset lines carry only SyncAssetV2 fields', async () => {
    const { a, b, bob } = await twoUsers();
    const p = await photo(a);
    const hidden = await photo(a, 'locked.jpg');
    await call(a, 'POST', '/albums', { albumName: 'x', assetIds: [p, hidden], albumUsers: [{ userId: bob.id, role: 'viewer' }] });
    await env.DB.prepare("UPDATE assets SET visibility = 'locked' WHERE id = ?1").bind(hidden).run();
    const lines = await sync(b);
    expect(JSON.stringify(lines)).not.toContain(hidden);
    const asset = lines.find((l) => l.type === 'AlbumAssetCreateV2')!;
    const allowed = Object.keys((await import('../vendor/immich-openapi.json')).default.components.schemas.SyncAssetV2.properties).sort();
    expect(Object.keys(asset.data).sort()).toEqual(allowed);
    expect((await call(b, 'GET', `/assets/${hidden}`)).status).toBe(404);
  });

  it('a new member does not receive removals that happened before joining', async () => {
    const { a, c, bob, carol } = await twoUsers();
    const p = await photo(a);
    const albumId = (await call(a, 'POST', '/albums', { albumName: 'x', assetIds: [p], albumUsers: [{ userId: bob.id, role: 'viewer' }] })).body.id;
    await call(a, 'DELETE', `/albums/${albumId}/user/${bob.id}`);
    await call(a, 'DELETE', `/albums/${albumId}/assets`, { ids: [p] });
    await call(a, 'PUT', `/albums/${albumId}/users`, { albumUsers: [{ userId: carol.id }] });
    const lines = await sync(c);
    expect(types(lines).filter((t) => t.endsWith('DeleteV1'))).toEqual([]);
  });

  it('accepts three-part acks only for backfill types', () => {
    const id = '00000000-0000-7000-8000-000000000001';
    expect(parseAck(`AlbumUserBackfillV1|${id}|complete`)).toEqual({ type: 'AlbumUserBackfillV1', id, extraId: 'complete' });
    expect(parseAck(`AlbumAssetBackfillV2|${id}|${id}`).extraId).toBe(id);
    expect(() => parseAck(`AlbumV2|${id}|${id}`)).toThrow();
    expect(() => parseAck(`AlbumUserBackfillV1|${id}|junk`)).toThrow();
  });
});
