import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { authHeaders, BASE, createUser, login, uploadAsset } from './helpers';

async function setup() {
  await createUser();
  const token = await login();
  const bytes = crypto.getRandomValues(new Uint8Array(10_000));
  const { body } = await uploadAsset(token, bytes);
  return { token, id: body.id, bytes };
}

describe('media', () => {
  it('missing thumbnail is 404 no-store', async () => {
    const { token, id } = await setup();
    const res = await SELF.fetch(`${BASE}/api/assets/${id}/thumbnail?size=thumbnail&edited=true`, { headers: authHeaders(token) });
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('serves thumbnail, preview and fullsize (from preview) with caching and etag', async () => {
    const { token, id } = await setup();
    await env.MEDIA.put(`thumbs/${id}/thumbnail.webp`, 'T', { httpMetadata: { contentType: 'image/webp' } });
    await env.MEDIA.put(`thumbs/${id}/preview.jpeg`, 'P', { httpMetadata: { contentType: 'image/jpeg' } });
    await env.DB.prepare('UPDATE assets SET has_thumbnail = 1').run();
    const thumb = await SELF.fetch(`${BASE}/api/assets/${id}/thumbnail`, { headers: authHeaders(token) });
    expect(await thumb.text()).toBe('T');
    expect(thumb.headers.get('content-type')).toBe('image/webp');
    expect(thumb.headers.get('cache-control')).toBe('private, max-age=86400');
    expect(thumb.headers.get('etag')).toBeTruthy();
    expect(await (await SELF.fetch(`${BASE}/api/assets/${id}/thumbnail?size=preview`, { headers: authHeaders(token) })).text()).toBe('P');
    expect(await (await SELF.fetch(`${BASE}/api/assets/${id}/thumbnail?size=fullsize`, { headers: authHeaders(token) })).text()).toBe('P');
  });

  it('serves the original with range support', async () => {
    const { token, id, bytes } = await setup();
    const full = await SELF.fetch(`${BASE}/api/assets/${id}/original`, { headers: authHeaders(token) });
    expect(full.status).toBe(200);
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(bytes);
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    const part = await SELF.fetch(`${BASE}/api/assets/${id}/original`, { headers: { ...authHeaders(token), range: 'bytes=100-199' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 100-199/10000');
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(bytes.slice(100, 200));
  });

  it('does not serve another user\'s asset', async () => {
    const { id } = await setup();
    await createUser({ email: 'other@example.com', isAdmin: false });
    const other = await login('other@example.com');
    const res = await SELF.fetch(`${BASE}/api/assets/${id}/original`, { headers: authHeaders(other) });
    expect(res.status).toBe(404);
  });

  it('builds a valid content-disposition for names with emoji and line breaks', async () => {
    await createUser();
    const token = await login();
    const { body } = await uploadAsset(token, crypto.getRandomValues(new Uint8Array(500)), { fields: { filename: 'sum\r\nmer "\u{1F600}" caf\u00e9.jpg' } });
    const res = await SELF.fetch(`${BASE}/api/assets/${body.id}/original`, { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(
      `inline; filename="summer __ caf_.jpg"; filename*=UTF-8''summer%20%22%F0%9F%98%80%22%20caf%C3%A9.jpg`,
    );
  });
});
