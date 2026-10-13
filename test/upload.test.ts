import { env, SELF } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { expectResponse } from './contract';
import { authHeaders, BASE, createUser, login, uploadAsset } from './helpers';

const jpeg = () => crypto.getRandomValues(new Uint8Array(4096));

async function setup() {
  await createUser();
  return login();
}

describe('POST /assets', () => {
  it('stores the original, inserts a pending asset, and enqueues processing', async () => {
    const token = await setup();
    const bytes = jpeg();
    const { status, body } = await uploadAsset(token, bytes);
    expect(status).toBe(201);
    expectResponse('/assets', 'post', 201, body);
    const row = await env.DB.prepare('SELECT * FROM assets WHERE id = ?1').bind(body.id).first<any>();
    expect(row.status).toBe('pending');
    expect(row.type).toBe('IMAGE');
    expect(row.original_file_name).toBe('IMG_0001.JPG');
    expect(row.file_size).toBe(4096);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes));
    expect(row.checksum).toBe(btoa(String.fromCharCode(...digest)));
    expect(await env.MEDIA.head(row.original_path)).not.toBeNull();
  });

  it('duplicate upload deletes the new object and returns the existing id', async () => {
    const token = await setup();
    const bytes = jpeg();
    const first = await uploadAsset(token, bytes);
    const second = await uploadAsset(token, bytes, { filename: 'copy.jpg' });
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ id: first.body.id, status: 'duplicate' });
    const listed = await env.MEDIA.list({ prefix: 'originals/' });
    expect(listed.objects).toHaveLength(1);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM assets').first('n')).toBe(1);
  });

  it('answers duplicates from x-immich-checksum without reading the body', async () => {
    const token = await setup();
    const bytes = jpeg();
    const first = await uploadAsset(token, bytes);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes));
    const res = await SELF.fetch(`${BASE}/api/assets`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'x-immich-checksum': btoa(String.fromCharCode(...digest)), 'content-type': 'multipart/form-data; boundary=x' },
      body: 'not a valid body',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: first.body.id, status: 'duplicate' });
  });

  it('accepts fields after the file and fills defaults for missing device fields', async () => {
    const token = await setup();
    const form = new FormData();
    form.append('fileCreatedAt', '2024-05-04T10:00:00.000Z');
    form.append('fileModifiedAt', '2024-05-04T10:00:00.000Z');
    form.append('assetData', new File([jpeg()], 'web.png'));
    form.append('visibility', 'hidden');
    const res = await SELF.fetch(`${BASE}/api/assets`, { method: 'POST', headers: authHeaders(token), body: form });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const row = await env.DB.prepare('SELECT visibility, device_id, device_asset_id FROM assets WHERE id = ?1').bind(id).first<any>();
    expect(row.visibility).toBe('hidden');
    expect(row.device_id).toBe('WEB');
    expect(row.device_asset_id).toMatch(/^web-/);
  });

  it('rejects unsupported file types with 400', async () => {
    const token = await setup();
    const { status } = await uploadAsset(token, jpeg(), { filename: 'notes.txt' });
    expect(status).toBe(400);
    expect((await env.MEDIA.list({ prefix: 'originals/' })).objects).toHaveLength(0);
  });

  it('truncated body aborts and inserts nothing', async () => {
    const token = await setup();
    const boundary = 'BOUNDARY123';
    const head = `--${boundary}\r\nContent-Disposition: form-data; name="fileCreatedAt"\r\n\r\n2024-05-04T10:00:00.000Z\r\n--${boundary}\r\nContent-Disposition: form-data; name="fileModifiedAt"\r\n\r\n2024-05-04T10:00:00.000Z\r\n--${boundary}\r\nContent-Disposition: form-data; name="assetData"; filename="a.jpg"\r\n\r\n`;
    const res = await SELF.fetch(`${BASE}/api/assets`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': `multipart/form-data; boundary=${boundary}` },
      body: head + 'x'.repeat(5000),
    });
    expect(res.status).toBe(400);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM assets').first('n')).toBe(0);
    expect((await env.MEDIA.list({ prefix: 'originals/' })).objects).toHaveLength(0);
  });

  it('rejects uploads over quota', async () => {
    const token = await setup();
    await env.DB.prepare('UPDATE users SET quota_bytes = 100').run();
    const { status } = await uploadAsset(token, jpeg());
    expect(status).toBe(400);
  });
});

describe('POST /assets/bulk-upload-check', () => {
  it('rejects known checksums and accepts new ones', async () => {
    const token = await setup();
    const bytes = jpeg();
    const { body } = await uploadAsset(token, bytes);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes));
    const hex = [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
    const res = await SELF.fetch(`${BASE}/api/assets/bulk-upload-check`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ assets: [{ id: 'one', checksum: hex }, { id: 'two', checksum: 'ab'.repeat(20) }] }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expectResponse('/assets/bulk-upload-check', 'post', 200, json);
    expect(json).toEqual({
      results: [
        { id: 'one', action: 'reject', reason: 'duplicate', assetId: body.id, isTrashed: false },
        { id: 'two', action: 'accept' },
      ],
    });
  });
});

const hexSha1 = async (b: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-1', b))].map((x) => x.toString(16).padStart(2, '0')).join('');
const noObjects = async () => expect((await env.MEDIA.list({ prefix: 'originals/' })).objects).toHaveLength(0);
const rowCount = () => env.DB.prepare('SELECT count(*) AS n FROM assets').first('n');

describe('POST /assets validation and safety', () => {
  it('rejects an invalid visibility', async () => {
    const token = await setup();
    const { status } = await uploadAsset(token, jpeg(), { fields: { visibility: 'bogus' } });
    expect(status).toBe(400);
    expect(await rowCount()).toBe(0);
    await noObjects();
  });

  it('rejects an invalid fileCreatedAt', async () => {
    const token = await setup();
    const { status } = await uploadAsset(token, jpeg(), { fields: { fileCreatedAt: 'garbage' } });
    expect(status).toBe(400);
    expect(await rowCount()).toBe(0);
    await noObjects();
  });

  it("rejects linking another user's video", async () => {
    const token = await setup();
    const other = await createUser({ email: 'b@example.com', isAdmin: false });
    const video = await uploadAsset(token, jpeg(), { filename: 'clip.mp4' });
    await env.DB.prepare('UPDATE assets SET owner_id = ?1').bind(other.id).run();
    const { status } = await uploadAsset(token, jpeg(), { fields: { livePhotoVideoId: video.body.id } });
    expect(status).toBe(400);
    expect(await rowCount()).toBe(1);
    expect((await env.MEDIA.list({ prefix: 'originals/' })).objects).toHaveLength(1);
  });

  it('rejects a non-UUID or non-video livePhotoVideoId', async () => {
    const token = await setup();
    const photo = await uploadAsset(token, jpeg());
    expect((await uploadAsset(token, jpeg(), { fields: { livePhotoVideoId: 'nope' } })).status).toBe(400);
    expect((await uploadAsset(token, jpeg(), { fields: { livePhotoVideoId: photo.body.id } })).status).toBe(400);
    expect(await rowCount()).toBe(1);
  });

  it('links its own video and hides it with a new update_id', async () => {
    const token = await setup();
    const video = await uploadAsset(token, jpeg(), { filename: 'clip.mp4' });
    const before = await env.DB.prepare('SELECT visibility, update_id FROM assets WHERE id = ?1').bind(video.body.id).first<any>();
    expect(before.visibility).toBe('timeline');
    const photo = await uploadAsset(token, jpeg(), { fields: { livePhotoVideoId: video.body.id } });
    expect(photo.status).toBe(201);
    const after = await env.DB.prepare('SELECT visibility, update_id FROM assets WHERE id = ?1').bind(video.body.id).first<any>();
    expect(after.visibility).toBe('hidden');
    expect(after.update_id).not.toBe(before.update_id);
    const row = await env.DB.prepare('SELECT live_photo_video_id FROM assets WHERE id = ?1').bind(photo.body.id).first<any>();
    expect(row.live_photo_video_id).toBe(video.body.id);
  });

  it('re-enqueues a duplicate whose asset is still pending, and survives a failing queue', async () => {
    const token = await setup();
    const bytes = jpeg();
    const send = vi.spyOn(env.PROCESS_QUEUE, 'send').mockRejectedValue(new Error('queue down'));
    try {
      const first = await uploadAsset(token, bytes);
      expect(first.status).toBe(201);
      expect(send).toHaveBeenCalledTimes(1);
      const second = await uploadAsset(token, bytes);
      expect(second.status).toBe(200);
      expect(send).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenLastCalledWith({ assetId: first.body.id });
      await env.DB.prepare("UPDATE assets SET status = 'ready'").run();
      await uploadAsset(token, bytes);
      expect(send).toHaveBeenCalledTimes(2);
    } finally {
      send.mockRestore();
    }
  });

  it('treats a hex x-immich-checksum as a duplicate', async () => {
    const token = await setup();
    const bytes = jpeg();
    const first = await uploadAsset(token, bytes);
    const res = await SELF.fetch(`${BASE}/api/assets`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'x-immich-checksum': await hexSha1(bytes), 'content-type': 'multipart/form-data; boundary=x' },
      body: 'x',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: first.body.id, status: 'duplicate' });
  });

  it('admits only one of two concurrent uploads when quota fits one file', async () => {
    const token = await setup();
    await env.DB.prepare('UPDATE users SET quota_bytes = 5000').run();
    const [a, b] = await Promise.all([uploadAsset(token, jpeg()), uploadAsset(token, jpeg())]);
    expect([a.status, b.status].sort()).toEqual([201, 400]);
    expect(await rowCount()).toBe(1);
    expect((await env.MEDIA.list({ prefix: 'originals/' })).objects).toHaveLength(1);
    expect(await env.DB.prepare('SELECT usage_bytes FROM users').first('usage_bytes')).toBe(4096);
  });

  it('rejects a second assetData part and cleans up', async () => {
    const token = await setup();
    const form = new FormData();
    form.append('fileCreatedAt', '2024-05-04T10:00:00.000Z');
    form.append('fileModifiedAt', '2024-05-04T10:00:00.000Z');
    form.append('assetData', new File([jpeg()], 'a.jpg'));
    form.append('assetData', new File([jpeg()], 'b.jpg'));
    const res = await SELF.fetch(`${BASE}/api/assets`, { method: 'POST', headers: authHeaders(token), body: form });
    expect(res.status).toBe(400);
    expect(await rowCount()).toBe(0);
    await noObjects();
  });
});

describe('bulk-upload-check validation', () => {
  it.each([{}, { assets: 'x' }, { assets: [{ id: 'a', checksum: 5 }] }, { assets: [null] }])('rejects %j', async (body) => {
    const token = await setup();
    const res = await SELF.fetch(`${BASE}/api/assets/bulk-upload-check`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /assets commit failure', () => {
  it('keeps the original and answers 201 when D1 commits but reports failure', async () => {
    const token = await setup();
    const realBatch = env.DB.batch.bind(env.DB);
    const spy = vi.spyOn(env.DB, 'batch').mockImplementationOnce(async (stmts) => {
      await realBatch(stmts);
      throw new Error('D1_ERROR: network connection lost');
    });
    const res = await uploadAsset(token, jpeg());
    spy.mockRestore();
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('created');
    expect(await env.DB.prepare('SELECT count(*) AS n FROM assets WHERE id = ?1').bind(res.body.id).first('n')).toBe(1);
    expect((await env.MEDIA.list({ prefix: 'originals/' })).objects).toHaveLength(1);
  });

  it('discards the original when the insert really failed', async () => {
    const token = await setup();
    const spy = vi.spyOn(env.DB, 'batch').mockRejectedValueOnce(new Error('D1_ERROR: boom'));
    const res = await SELF.fetch(`${BASE}/api/assets`, { method: 'POST', headers: authHeaders(token), body: (() => { const f = new FormData(); f.append('fileCreatedAt', '2024-05-04T10:00:00.000Z'); f.append('fileModifiedAt', '2024-05-04T10:00:00.000Z'); f.append('assetData', new File([jpeg()], 'a.jpg')); return f; })() });
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect((await env.MEDIA.list({ prefix: 'originals/' })).objects).toHaveLength(0);
  });
});
