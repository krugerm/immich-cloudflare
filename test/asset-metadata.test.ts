import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { expectResponse, expectSchema } from './contract';
import { call, setupAssets, sync } from './stream-b';

describe('asset metadata', () => {
  it('upserts, lists, reads and deletes keys', async () => {
    const { token, ids } = await setupAssets(1);
    const put = await call(token, 'PUT', `/assets/${ids[0]}/metadata`, { items: [{ key: 'mobile-app', value: { iCloudId: 'abc' } }, { key: 'note', value: { a: 1 } }] });
    expect(put.status).toBe(200);
    expectResponse('/assets/{id}/metadata', 'put', 200, put.json);
    await call(token, 'PUT', `/assets/${ids[0]}/metadata`, { items: [{ key: 'note', value: { a: 2 } }] });
    const list = await call(token, 'GET', `/assets/${ids[0]}/metadata`);
    expectResponse('/assets/{id}/metadata', 'get', 200, list.json);
    expect(list.json.map((m: any) => [m.key, m.value])).toEqual([['mobile-app', { iCloudId: 'abc' }], ['note', { a: 2 }]]);
    const one = await call(token, 'GET', `/assets/${ids[0]}/metadata/note`);
    expectResponse('/assets/{id}/metadata/{key}', 'get', 200, one.json);
    expect(one.json.value).toEqual({ a: 2 });
    expect((await call(token, 'GET', `/assets/${ids[0]}/metadata/missing`)).status).toBe(400);
    expect((await call(token, 'DELETE', `/assets/${ids[0]}/metadata/note`)).status).toBe(204);
    expect((await call(token, 'DELETE', `/assets/${ids[0]}/metadata/note`)).status).toBe(204); // idempotent
    expect((await call(token, 'GET', `/assets/${ids[0]}/metadata`)).json).toHaveLength(1);
  });

  it('syncs upserts as AssetMetadataV1 and deletes as AssetMetadataDeleteV1, once each', async () => {
    const { token, ids } = await setupAssets(1);
    await call(token, 'PUT', `/assets/${ids[0]}/metadata`, { items: [{ key: 'a', value: { n: 1 } }, { key: 'b', value: {} }] });
    await call(token, 'DELETE', `/assets/${ids[0]}/metadata/b`);
    await call(token, 'DELETE', `/assets/${ids[0]}/metadata/never-existed`);
    const lines = await sync(token, ['AssetMetadataV1']);
    const upserts = lines.filter((l) => l.type === 'AssetMetadataV1');
    const deletes = lines.filter((l) => l.type === 'AssetMetadataDeleteV1');
    expect(upserts.map((l) => l.data)).toEqual([{ assetId: ids[0], key: 'a', value: { n: 1 } }]);
    expect(deletes.map((l) => l.data)).toEqual([{ assetId: ids[0], key: 'b' }]);
    expectSchema('SyncAssetMetadataV1', upserts[0].data);
    expectSchema('SyncAssetMetadataDeleteV1', deletes[0].data);
    expect(lines.at(-1)!.type).toBe('SyncCompleteV1');
  });

  it('bulk upsert and delete work across assets with one cursor per row', async () => {
    const { token, ids } = await setupAssets(2);
    const put = await call(token, 'PUT', '/assets/metadata', { items: ids.map((assetId) => ({ assetId, key: 'k', value: { v: 1 } })) });
    expect(put.status).toBe(200);
    expectResponse('/assets/metadata', 'put', 200, put.json);
    const cursors = (await env.DB.prepare('SELECT update_id FROM asset_metadata').all<{ update_id: string }>()).results.map((r) => r.update_id);
    expect(new Set(cursors).size).toBe(2);
    expect((await call(token, 'DELETE', '/assets/metadata', { items: [{ assetId: ids[0], key: 'k' }] })).status).toBe(204);
    expect((await env.DB.prepare('SELECT count(*) AS n FROM asset_metadata').first<{ n: number }>())!.n).toBe(1);
    expect((await env.DB.prepare('SELECT count(*) AS n FROM asset_metadata_audit').first<{ n: number }>())!.n).toBe(1);
  });

  it('removes metadata with the asset when it is purged', async () => {
    const { token, ids } = await setupAssets(1);
    await call(token, 'PUT', `/assets/${ids[0]}/metadata`, { items: [{ key: 'k', value: { v: 1 } }] });
    await call(token, 'DELETE', '/assets', { ids, force: true });
    expect((await env.DB.prepare('SELECT count(*) AS n FROM asset_metadata').first<{ n: number }>())!.n).toBe(0);
  });

  it('rejects bad input and other users assets with 400', async () => {
    const { token, ids, other } = await setupAssets(1, { second: true });
    const put = (t: string, body: unknown) => call(t, 'PUT', `/assets/${ids[0]}/metadata`, body);
    expect((await put(token, { items: [{ key: 'a', value: 'str' }] })).status).toBe(400);
    expect((await put(token, { items: [{ key: 'a', value: [] }] })).status).toBe(400);
    expect((await put(token, { items: [{ key: '', value: {} }] })).status).toBe(400);
    expect((await put(token, { items: [{ key: 'a', value: {} }, { key: 'a', value: {} }] })).status).toBe(400);
    expect((await put(token, {})).status).toBe(400);
    expect((await put(other, { items: [{ key: 'a', value: {} }] })).status).toBe(400);
    expect((await call(other, 'GET', `/assets/${ids[0]}/metadata`)).status).toBe(400);
    expect((await call(other, 'DELETE', `/assets/${ids[0]}/metadata/a`)).status).toBe(400);
    expect((await call(token, 'PUT', '/assets/metadata', { items: [{ assetId: 'x', key: 'a', value: {} }] })).status).toBe(400);
    expect((await call('bogus', 'GET', `/assets/${ids[0]}/metadata`)).status).toBe(401);
  });
});

describe('asset edits', () => {
  it('lists no edits and treats removal as a no-op', async () => {
    const { token, ids, other } = await setupAssets(1, { second: true });
    const res = await call(token, 'GET', `/assets/${ids[0]}/edits`);
    expectResponse('/assets/{id}/edits', 'get', 200, res.json);
    expect(res.json).toEqual({ assetId: ids[0], edits: [] });
    expect((await call(token, 'DELETE', `/assets/${ids[0]}/edits`)).status).toBe(204);
    expect((await call(other, 'GET', `/assets/${ids[0]}/edits`)).status).toBe(400);
    expect((await call(other, 'DELETE', `/assets/${ids[0]}/edits`)).status).toBe(400);
  });

  it('refuses to create edits', async () => {
    const { token, ids } = await setupAssets(1);
    const res = await call(token, 'PUT', `/assets/${ids[0]}/edits`, { edits: [{ action: 'rotate', parameters: { angle: 90 } }] });
    expect(res.status).toBe(400);
  });
});
