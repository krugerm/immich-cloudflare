import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { expectResponse } from './contract';
import { authHeaders, BASE, createUser, login, uploadAsset } from './helpers';

const get = async (token: string, path: string) => {
  const res = await SELF.fetch(`${BASE}/api${path}`, { headers: authHeaders(token) });
  return { status: res.status, body: await res.json<any>() };
};

describe('folder views', () => {
  it('lists the directory of original_path and its direct children', async () => {
    await createUser();
    await createUser({ email: 'other@example.com', isAdmin: false });
    const token = await login();
    const other = await login('other@example.com');
    const mk = async (t: string, n: number, name: string) => (await uploadAsset(t, crypto.getRandomValues(new Uint8Array(100 + n)), { filename: name })).body.id;
    const b = await mk(token, 1, 'b.jpg');
    const a = await mk(token, 2, 'a.jpg');
    const archived = await mk(token, 3, 'c.jpg');
    const trashed = await mk(token, 4, 'd.jpg');
    await mk(other, 5, 'x.jpg');
    await env.DB.prepare("UPDATE assets SET visibility = 'archive' WHERE id = ?1").bind(archived).run();
    await env.DB.prepare("UPDATE assets SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1").bind(trashed).run();
    // A nested asset: belongs to the sub folder, not the parent.
    await env.DB.prepare("UPDATE assets SET original_path = replace(original_path, 'originals/', 'originals/deep/sub/') WHERE id = ?1").bind(b).run();
    await env.DB.prepare("UPDATE assets SET original_path = 'originals/deep/' || ?2 WHERE id = ?1").bind(a, `${a}.jpg`).run();

    const paths = await get(token, '/view/folder/unique-paths');
    expect(paths.status).toBe(200);
    expectResponse('/view/folder/unique-paths', 'get', 200, paths.body);
    const owner = (await env.DB.prepare("SELECT id FROM users WHERE email = 'admin@example.com'").first<string>('id'))!;
    expect(paths.body).toEqual(['originals/deep', `originals/deep/sub/${owner}`]);

    for (const q of ['originals/deep', 'originals/deep/']) {
      const res = await get(token, `/view/folder?path=${encodeURIComponent(q)}`);
      expect(res.status).toBe(200);
      expectResponse('/view/folder', 'get', 200, res.body);
      expect(res.body.map((x: { id: string }) => x.id)).toEqual([a]);
    }
    const sub = await get(token, `/view/folder?path=${encodeURIComponent(`originals/deep/sub/${owner}`)}`);
    expect(sub.body.map((x: { id: string }) => x.id)).toEqual([b]);
    expect((await get(token, '/view/folder?path=nothing')).body).toEqual([]);
    expect((await get(token, '/view/folder?path=%25')).body).toEqual([]); // no wildcard matching
  });

  it('orders children by file name and rejects a missing path', async () => {
    await createUser();
    const token = await login();
    const ids: string[] = [];
    const owner = (await env.DB.prepare("SELECT id FROM users WHERE email = 'admin@example.com'").first<string>('id'))!;
    for (let i = 0; i < 3; i++) ids.push((await uploadAsset(token, crypto.getRandomValues(new Uint8Array(100 + i)))).body.id);
    const res = await get(token, `/view/folder?path=originals/${owner}`);
    expect(res.body.map((x: { id: string }) => x.id)).toEqual(
      [...ids].sort((x, y) => (`${x}.` < `${y}.` ? -1 : 1)),
    );
    expect((await get(token, '/view/folder')).status).toBe(400);
  });

  it('requires auth', async () => {
    expect((await SELF.fetch(`${BASE}/api/view/folder/unique-paths`)).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/api/view/folder?path=x`)).status).toBe(401);
  });
});
