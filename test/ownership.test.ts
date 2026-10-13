import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { uploadAsset } from './helpers';
import { call, setupAssets } from './stream-b';

const row = (id: string) => env.DB.prepare('SELECT * FROM assets WHERE id = ?1').bind(id).first<any>();

/** The caller owns `mine`; `theirs` belongs to the other user. Every mixed request must change nothing. */
async function mixed() {
  const { token, ids, other } = await setupAssets(2, { second: true });
  const theirs = (await uploadAsset(other, crypto.getRandomValues(new Uint8Array(77)))).body.id;
  const theirVideo = (await uploadAsset(other, crypto.getRandomValues(new Uint8Array(78)), { filename: 'clip.mov' })).body.id;
  return { token, other, mine: ids, theirs, theirVideo };
}

async function snapshot(ids: string[]) {
  return JSON.stringify(await Promise.all(ids.map(row)));
}

describe('ownership of every id', () => {
  it('bulk update with a foreign id anywhere in the list changes nothing', async () => {
    const { token, mine, theirs } = await mixed();
    const before = await snapshot([...mine, theirs]);
    for (const ids of [[...mine, theirs], [theirs, ...mine]]) {
      const res = await call(token, 'PUT', '/assets', { ids, isFavorite: true, description: 'x', visibility: 'archive', dateTimeOriginal: '2020-01-01T00:00:00.000Z' });
      expect(res.status).toBe(400);
      expect(res.json.message).toBe('Not found or no asset.update access');
    }
    expect(await snapshot([...mine, theirs])).toBe(before);
    expect((await env.DB.prepare('SELECT count(*) AS n FROM asset_exif').first<{ n: number }>())!.n).toBe(0);
  });

  it('single update of a foreign asset, or linking a foreign video, changes nothing', async () => {
    const { token, mine, theirs, theirVideo } = await mixed();
    const before = await snapshot([...mine, theirs, theirVideo]);
    expect((await call(token, 'PUT', `/assets/${theirs}`, { isFavorite: true })).status).toBe(400);
    expect((await call(token, 'PUT', `/assets/${mine[0]}`, { livePhotoVideoId: theirVideo })).status).toBe(400);
    expect((await call(token, 'PUT', '/assets/copy', { sourceId: mine[0], targetId: theirs })).status).toBe(400);
    expect((await call(token, 'POST', '/assets/jobs', { assetIds: [mine[0], theirs], name: 'refresh-metadata' })).status).toBe(400);
    expect((await call(token, 'PUT', `/assets/${mine[0]}/metadata`, { items: [{ key: 'k', value: {} }] })).status).toBe(200);
    expect((await call(token, 'PUT', '/assets/metadata', { items: [{ assetId: mine[0], key: 'a', value: {} }, { assetId: theirs, key: 'a', value: {} }] })).status).toBe(400);
    expect(await snapshot([...mine, theirs, theirVideo])).toBe(before);
    expect((await env.DB.prepare('SELECT count(*) AS n FROM asset_metadata WHERE asset_id = ?1').bind(theirs).first<{ n: number }>())!.n).toBe(0);
  });

  it('bulk delete (trash and force) with a foreign id changes nothing', async () => {
    const { token, mine, theirs } = await mixed();
    const before = await snapshot([...mine, theirs]);
    for (const force of [false, true]) {
      const res = await call(token, 'DELETE', '/assets', { ids: [...mine, theirs], force });
      expect(res.status).toBe(400);
      expect(res.json.message).toBe('Not found or no asset.delete access');
    }
    expect(await snapshot([...mine, theirs])).toBe(before);
    expect((await env.DB.prepare('SELECT count(*) AS n FROM asset_audit').first<{ n: number }>())!.n).toBe(0);
  });

  it('restore with a foreign id changes nothing, and restore-all ignores foreign trash', async () => {
    const { token, other, mine, theirs } = await mixed();
    await call(token, 'DELETE', '/assets', { ids: mine });
    await call(other, 'DELETE', '/assets', { ids: [theirs] });
    const before = await snapshot([...mine, theirs]);
    const res = await call(token, 'POST', '/trash/restore/assets', { ids: [...mine, theirs] });
    expect(res.status).toBe(400);
    expect(await snapshot([...mine, theirs])).toBe(before);
    const theirsBefore = await row(theirs);
    await call(token, 'POST', '/trash/restore');
    await call(token, 'POST', '/trash/empty');
    expect(await row(theirs)).toEqual(theirsBefore);
  });
});
