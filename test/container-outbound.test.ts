import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { grantKey } from '../src/container/grant';
import { handleMediaOutbound } from '../src/container/outbound';
import { mediaGrantSecret, resetGrantSecretCache } from '../src/container/grant-secret';

const bytes = Uint8Array.from({ length: 1000 }, (_, i) => i % 256);
const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e';

const SECRET = 'test-media-grant-secret';

/** A container request for `path`, signed with a grant for its method unless `grant: false`. */
async function req(path: string, init: RequestInit & { range?: string; grant?: false } = {}): Promise<Request> {
  const headers = new Headers(init.headers);
  if (init.range) headers.set('range', init.range);
  const signed = init.grant === false ? path : await grantKey(SECRET, init.method === 'PUT' ? 'write' : 'read', path);
  return new Request(`http://media.r2/${signed}`, { ...init, headers });
}

async function body(res: Response): Promise<number[]> {
  return [...new Uint8Array(await res.arrayBuffer())];
}

describe('media.r2 outbound handler', () => {
  beforeEach(async () => {
    await env.MEDIA.put('originals/u/a.mov', bytes);
  });

  it('serves a closed range with 206 and Content-Range', async () => {
    const res = await handleMediaOutbound(await req('originals/u/a.mov', { range: 'bytes=10-19' }), env);
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 10-19/1000');
    expect(res.headers.get('content-length')).toBe('10');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(await body(res)).toEqual([...bytes.slice(10, 20)]);
  });

  it('serves an open-ended range', async () => {
    const res = await handleMediaOutbound(await req('originals/u/a.mov', { range: 'bytes=990-' }), env);
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 990-999/1000');
    expect(await body(res)).toEqual([...bytes.slice(990)]);
  });

  it('serves a suffix range', async () => {
    const res = await handleMediaOutbound(await req('originals/u/a.mov', { range: 'bytes=-5' }), env);
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 995-999/1000');
    expect(res.headers.get('content-length')).toBe('5');
    expect(await body(res)).toEqual([...bytes.slice(995)]);
  });

  it('serves the whole object without Range', async () => {
    const res = await handleMediaOutbound(await req('originals/u/a.mov'), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('1000');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(await body(res)).toEqual([...bytes]);
  });

  it('answers HEAD with the size and no body', async () => {
    const res = await handleMediaOutbound(await req('originals/u/a.mov', { method: 'HEAD' }), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('1000');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.body).toBeNull();
  });

  it('rejects an unsatisfiable range with 416', async () => {
    const res = await handleMediaOutbound(await req('originals/u/a.mov', { range: 'bytes=2000-2010' }), env);
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */1000');
  });

  it('rejects a malformed or multi-part range with 416', async () => {
    for (const range of ['bytes=5-2', 'bytes=0-1,4-5', 'items=0-1']) {
      const res = await handleMediaOutbound(await req('originals/u/a.mov', { range }), env);
      expect(res.status, range).toBe(416);
    }
  });

  it('forbids reads outside originals/ and derived/', async () => {
    expect((await handleMediaOutbound(await req('thumbs/x'), env)).status).toBe(403);
    expect((await handleMediaOutbound(await req('originalsx/u/a.mov'), env)).status).toBe(403);
  });

  it('forbids .. segments after percent-decoding', async () => {
    const res = await handleMediaOutbound(await req('derived%2F..%2Foriginals%2Fu%2Fa.mov'), env);
    expect(res.status).toBe(403);
    // A literal ../ is resolved by the URL parser before the handler sees it; it lands on the normalized key.
    const literal = new Request('http://media.r2/derived/../originals/u/a.mov');
    expect(new URL(literal.url).pathname).toBe('/originals/u/a.mov');
  });

  it('returns 404 for a missing object', async () => {
    expect((await handleMediaOutbound(await req('originals/u/missing.mov'), env)).status).toBe(404);
    expect((await handleMediaOutbound(await req('originals/u/missing.mov', { method: 'HEAD' }), env)).status).toBe(404);
  });

  it('stores a derived JPEG on PUT', async () => {
    const key = `derived/${uuid}/poster.jpeg`;
    const res = await handleMediaOutbound(
      await req(key, { method: 'PUT', body: new Uint8Array([1, 2, 3]), headers: { 'content-length': '3' } }),
      env,
    );
    expect(res.status).toBe(201);
    const obj = await env.MEDIA.get(key);
    expect(obj).not.toBeNull();
    expect(obj!.httpMetadata?.contentType).toBe('image/jpeg');
    expect([...new Uint8Array(await obj!.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it('forbids PUT outside derived/<uuid>/(poster|full).jpeg', async () => {
    const put = async (path: string) =>
      handleMediaOutbound(await req(path, { method: 'PUT', body: new Uint8Array([1]), headers: { 'content-length': '1' } }), env);
    expect((await put('originals/u/b.mov')).status).toBe(403);
    expect((await put(`derived/${uuid}/other.jpeg`)).status).toBe(403);
    expect((await put('derived/not-a-uuid/poster.jpeg')).status).toBe(403);
    expect(await env.MEDIA.head('originals/u/b.mov')).toBeNull();
  });

  it('requires Content-Length on PUT and caps it at 20 MB', async () => {
    const key = `derived/${uuid}/full.jpeg`;
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array([1]));
        c.close();
      },
    });
    const noLength = await handleMediaOutbound(await req(key, { method: 'PUT', body: stream, duplex: 'half' } as RequestInit), env);
    expect(noLength.status).toBe(411);
    const tooBig = await handleMediaOutbound(
      await req(key, { method: 'PUT', body: new Uint8Array([1]), headers: { 'content-length': String(20 * 1024 * 1024 + 1) } }),
      env,
    );
    expect(tooBig.status).toBe(413);
    expect(await env.MEDIA.head(key)).toBeNull();
  });

  it('rejects other methods with 405', async () => {
    expect((await handleMediaOutbound(await req('originals/u/a.mov', { method: 'DELETE' }), env)).status).toBe(405);
  });

  describe('grants', () => {
    it('refuses a key without a grant', async () => {
      expect((await handleMediaOutbound(await req('originals/u/a.mov', { grant: false }), env)).status).toBe(403);
    });

    it('refuses an expired grant', async () => {
      const old = await grantKey(SECRET, 'read', 'originals/u/a.mov', Date.now() - 10 * 60_000);
      expect((await handleMediaOutbound(await req(old, { grant: false }), env)).status).toBe(403);
    });

    it('refuses a grant signed with another secret', async () => {
      const forged = await grantKey('other-secret', 'read', 'originals/u/a.mov');
      expect((await handleMediaOutbound(await req(forged, { grant: false }), env)).status).toBe(403);
    });

    it('binds the grant to its key: a signature cannot be reused for another file', async () => {
      const g = await grantKey(SECRET, 'read', 'originals/u/a.mov');
      await env.MEDIA.put('originals/v/b.mov', bytes);
      const swapped = g.replace('originals/u/a.mov', 'originals/v/b.mov');
      expect((await handleMediaOutbound(await req(swapped, { grant: false }), env)).status).toBe(403);
    });

    it('binds the grant to its method: a read grant cannot write', async () => {
      const key = `derived/${uuid}/poster.jpeg`;
      const read = await grantKey(SECRET, 'read', key);
      const res = await handleMediaOutbound(
        await req(read, { grant: false, method: 'PUT', body: new Uint8Array([1]), headers: { 'content-length': '1' } }),
        env,
      );
      expect(res.status).toBe(403);
      expect(await env.MEDIA.head(key)).toBeNull();
    });

    it('without MEDIA_GRANT_SECRET verifies against the generated key, and rejects grants signed with another', async () => {
      resetGrantSecretCache();
      const bare = { ...env, MEDIA_GRANT_SECRET: undefined } as Env;
      // signed with the configured secret, not the generated one
      expect((await handleMediaOutbound(await req('originals/u/a.mov'), bare)).status).toBe(403);
      await env.MEDIA.put('originals/u/gen.mov', new Uint8Array([1, 2, 3]));
      const key = await grantKey(await mediaGrantSecret(bare), 'read', 'originals/u/gen.mov');
      const res = await handleMediaOutbound(new Request(`http://media.r2/${key}`), bare);
      expect(res.status).toBe(200);
      resetGrantSecretCache();
    });

    it('fails closed when no key can be read', async () => {
      resetGrantSecretCache();
      const broken = { ...env, MEDIA_GRANT_SECRET: undefined, DB: { prepare: () => { throw new Error('d1 down'); } } } as unknown as Env;
      expect((await handleMediaOutbound(await req('originals/u/a.mov'), broken)).status).toBe(503);
      resetGrantSecretCache();
    });
  });
});
