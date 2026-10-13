import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { call, photo, twoUsers } from './album-helpers';

// Final review item 7: tagging needs asset.update access, which (Immich checkOwnerAccess with hasElevatedPermission)
// excludes locked-folder assets unless the session is PIN-elevated. Removing a tag from an asset stays allowed.

async function setup() {
  const { a } = await twoUsers();
  const locked = await photo(a, 'locked.jpg');
  await env.DB.prepare("UPDATE assets SET visibility = 'locked' WHERE id = ?1").bind(locked).run();
  const tag = (await call(a, 'POST', '/tags', { name: 'secret' })).body.id as string;
  return { a, locked, tag };
}

async function elevate(token: string) {
  expect((await call(token, 'POST', '/auth/pin-code', { pinCode: '123456' })).status).toBe(204);
  expect((await call(token, 'POST', '/auth/session/unlock', { pinCode: '123456' })).status).toBe(204);
}

const tagged = (tag: string, asset: string) => env.DB.prepare('SELECT 1 FROM tag_asset WHERE tag_id = ?1 AND asset_id = ?2').bind(tag, asset).first();

describe('tagging locked assets', () => {
  it('PUT /tags/:id/assets refuses a locked asset without elevation and accepts it with', async () => {
    const { a, locked, tag } = await setup();
    expect((await call(a, 'PUT', `/tags/${tag}/assets`, { ids: [locked] })).body).toEqual([{ id: locked, success: false, error: 'no_permission' }]);
    expect(await tagged(tag, locked)).toBeNull();
    await elevate(a);
    expect((await call(a, 'PUT', `/tags/${tag}/assets`, { ids: [locked] })).body).toEqual([{ id: locked, success: true }]);
    expect(await tagged(tag, locked)).not.toBeNull();
  });

  it('PUT /tags/assets skips a locked asset without elevation and tags it with', async () => {
    const { a, locked, tag } = await setup();
    expect((await call(a, 'PUT', '/tags/assets', { tagIds: [tag], assetIds: [locked] })).body).toEqual({ count: 0 });
    await elevate(a);
    expect((await call(a, 'PUT', '/tags/assets', { tagIds: [tag], assetIds: [locked] })).body).toEqual({ count: 1 });
  });

  it('DELETE /tags/:id/assets removes a tag from a locked asset without elevation', async () => {
    const { a, locked, tag } = await setup();
    await env.DB.prepare('INSERT INTO tag_asset (tag_id, asset_id) VALUES (?1, ?2)').bind(tag, locked).run();
    expect((await call(a, 'DELETE', `/tags/${tag}/assets`, { ids: [locked] })).body).toEqual([{ id: locked, success: true }]);
  });
});
