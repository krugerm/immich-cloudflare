// Outbound handler for `http://media.r2/<key>` requests made by the media container. It runs in the Workers runtime
// and serves R2 through the MEDIA binding, so the container holds no credentials. Every key must carry a grant
// (src/container/grant.ts) issued by the client for that job.

import { verifyGrant } from './grant';

const MAX_PUT_BYTES = 20 * 1024 * 1024;
const READ_PREFIXES = ['originals/', 'derived/'];
const WRITE_KEY = /^derived\/[0-9a-f-]{36}\/(poster|full)\.jpeg$/;

function status(code: number, text: string, headers?: HeadersInit): Response {
  return new Response(text, { status: code, headers });
}

/** The URL path without the leading `/`, percent-decoded once; null when undecodable or it has `.`/`..` segments. */
function objectKey(request: Request): string | null {
  let key: string;
  try {
    key = decodeURIComponent(new URL(request.url).pathname.slice(1));
  } catch {
    return null;
  }
  if (key.split('/').some((s) => s === '..' || s === '.')) return null;
  return key;
}

/** Parses a single `bytes=` range. undefined: no Range header; null: malformed or multi-part. */
function parseRange(header: string | null): R2Range | null | undefined {
  if (header === null) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') return { suffix: Number(m[2]) };
  const offset = Number(m[1]);
  if (m[2] === '') return { offset };
  const end = Number(m[2]);
  if (end < offset) return null;
  return { offset, length: end - offset + 1 };
}

/** Resolves a range against the object size; null when unsatisfiable. */
function resolveRange(range: R2Range, size: number): { offset: number; length: number } | null {
  if ('suffix' in range) {
    if (range.suffix === 0 || size === 0) return null;
    const length = Math.min(range.suffix, size);
    return { offset: size - length, length };
  }
  const offset = range.offset ?? 0;
  if (offset >= size) return null;
  const length = Math.min(range.length ?? size - offset, size - offset);
  return { offset, length };
}

function objectHeaders(obj: R2Object): Headers {
  const headers = new Headers({ 'accept-ranges': 'bytes', etag: obj.httpEtag });
  if (obj.httpMetadata?.contentType) headers.set('content-type', obj.httpMetadata.contentType);
  return headers;
}

async function read(request: Request, env: Env, key: string): Promise<Response> {
  if (request.method === 'HEAD') {
    const obj = await env.MEDIA.head(key);
    if (!obj) return status(404, 'not found');
    const headers = objectHeaders(obj);
    headers.set('content-length', String(obj.size));
    return new Response(null, { status: 200, headers });
  }

  const range = parseRange(request.headers.get('range'));
  if (range === undefined) {
    const obj = await env.MEDIA.get(key);
    if (!obj) return status(404, 'not found');
    const headers = objectHeaders(obj);
    headers.set('content-length', String(obj.size));
    return new Response(obj.body, { status: 200, headers });
  }

  // Validate against the size first: R2 rejects an unsatisfiable range with an exception, not a status.
  const head = await env.MEDIA.head(key);
  if (!head) return status(404, 'not found');
  const resolved = range === null ? null : resolveRange(range, head.size);
  if (!resolved) return status(416, 'range not satisfiable', { 'content-range': `bytes */${head.size}` });
  // Serve the full requested range. Do not cap it: ffmpeg reads a shorter 206 as "Stream ends prematurely" and
  // reconnects with growing delays, which pushed a 10 MB moov-at-end HDR video past the job deadline (2026-10-13).
  // An abandoned open-ended read stops when ffmpeg closes the connection.

  const obj = await env.MEDIA.get(key, { range: resolved, onlyIf: { etagMatches: head.etag } });
  if (!obj) return status(404, 'not found');
  if (!('body' in obj)) return status(503, 'object changed during read');
  const headers = objectHeaders(obj);
  const end = resolved.offset + resolved.length - 1;
  headers.set('content-range', `bytes ${resolved.offset}-${end}/${obj.size}`);
  headers.set('content-length', String(resolved.length));
  return new Response(obj.body, { status: 206, headers });
}

async function write(request: Request, env: Env, key: string): Promise<Response> {
  if (!WRITE_KEY.test(key)) return status(403, 'forbidden');
  const header = request.headers.get('content-length');
  if (header === null || !/^\d+$/.test(header) || !request.body) return status(411, 'length required');
  const length = Number(header);
  if (length > MAX_PUT_BYTES) return status(413, 'payload too large');
  const body = request.body.pipeThrough(new FixedLengthStream(length));
  await env.MEDIA.put(key, body, { httpMetadata: { contentType: 'image/jpeg' } });
  return new Response(null, { status: 201 });
}

export async function handleMediaOutbound(request: Request, env: Env): Promise<Response> {
  const wrapped = objectKey(request);
  if (wrapped === null) return status(403, 'forbidden');
  const secret = env.MEDIA_GRANT_SECRET;
  if (!secret) return status(503, 'media grants not configured'); // fail closed
  const access = request.method === 'PUT' ? 'write' : 'read';
  const key = await verifyGrant(secret, access, wrapped);
  if (key === null) return status(403, 'forbidden');
  switch (request.method) {
    case 'GET':
    case 'HEAD':
      if (!READ_PREFIXES.some((p) => key.startsWith(p))) return status(403, 'forbidden');
      return read(request, env, key);
    case 'PUT':
      return write(request, env, key);
    default:
      return status(405, 'method not allowed', { allow: 'GET, HEAD, PUT' });
  }
}
