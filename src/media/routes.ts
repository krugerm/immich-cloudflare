import { Hono, type Context } from 'hono';
import type { AppEnv } from '../app';
import { canReadAsset, sharedLinkCanReadAsset } from '../access/assets';
import { allowLocked } from '../assets/access';
import type { AssetRow } from '../db/rows';
import { ImmichError } from '../http/errors';
import { getSharedLink, requireAuthOrSharedLink } from '../shared-links/auth';
import { thumbKey } from '../process/thumbs';
import { contentTypeFor, extensionOf } from '../upload/media-types';

/** Inline Content-Disposition with an ASCII fallback and an RFC 5987 UTF-8 name; control characters are dropped. */
export function contentDisposition(name: string): string {
  const clean = name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '');
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
  const encoded = encodeURIComponent(clean).replace(/['()*]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
  return `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export const mediaRoutes = new Hono<AppEnv>();

/**
 * Loads an asset the caller may read (Immich AssetRead, `canReadAsset`): own assets (locked ones only from a
 * PIN-elevated session), assets of shared albums, partner assets, or, for a shared-link request, the link's assets.
 * The name predates albums and partners: use it for read routes only; writes use loadOwnAsset.
 */
export async function loadOwnedAsset(c: Context<AppEnv>, id: string): Promise<AssetRow> {
  const db = c.env.DB;
  const shared = getSharedLink(c);
  const readable = shared
    ? await sharedLinkCanReadAsset(db, shared.link.id, id)
    : await canReadAsset(db, c.get('auth').user.id, id, { elevated: allowLocked(c) });
  const a = readable ? await db.prepare('SELECT * FROM assets WHERE id = ?1').bind(id).first<AssetRow>() : null;
  if (!a) throw new ImmichError(404, 'Asset not found');
  return a;
}

/** stream D: strict owner-only loader, for routes that modify an asset. */
export async function loadOwnAsset(c: Context<AppEnv>, id: string): Promise<AssetRow> {
  const a = await c.env.DB.prepare('SELECT * FROM assets WHERE id = ?1 AND owner_id = ?2')
    .bind(id, c.get('auth').user.id)
    .first<AssetRow>();
  if (!a || (a.visibility === 'locked' && !allowLocked(c))) throw new ImmichError(404, 'Asset not found');
  return a;
}

function objectResponse(object: R2ObjectBody | R2Object, body: ReadableStream | null, headers: Headers, rangeRequested: boolean): Response {
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('accept-ranges', 'bytes');
  if (rangeRequested && 'range' in object && object.range && 'offset' in object.range) {
    const offset = object.range.offset ?? 0;
    const length = object.range.length ?? object.size - offset;
    headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set('content-length', String(length));
    return new Response(body, { status: 206, headers });
  }
  headers.set('content-length', String(object.size));
  return new Response(body, { status: 200, headers });
}

async function serve(c: Context<AppEnv>, key: string, cacheControl: string, contentType?: string): Promise<Response> {
  const range = c.req.header('range');
  const object = await c.env.MEDIA.get(key, { range: range ? c.req.raw.headers : undefined, onlyIf: c.req.raw.headers });
  if (!object) return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
  const headers = new Headers({ 'cache-control': cacheControl });
  if (contentType) headers.set('content-type', contentType);
  if (!('body' in object)) return new Response(null, { status: 304, headers: { etag: object.httpEtag, 'cache-control': cacheControl } });
  return objectResponse(object, object.body, headers, Boolean(range));
}

mediaRoutes.get('/assets/:id/thumbnail', requireAuthOrSharedLink(), async (c) => {
  const a = await loadOwnedAsset(c, c.req.param('id'));
  if (!a.has_thumbnail) return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
  const size = c.req.query('size') === 'thumbnail' || !c.req.query('size') ? 'thumbnail' : 'preview';
  return serve(c, thumbKey(a.id, size), 'private, max-age=86400');
});

mediaRoutes.get('/assets/:id/original', requireAuthOrSharedLink(), async (c) => {
  const shared = getSharedLink(c);
  if (shared && !shared.link.allow_download) throw new ImmichError(400, 'Not found or no asset.download access');
  const a = await loadOwnedAsset(c, c.req.param('id'));
  const res = await serve(c, a.original_path, 'private, max-age=86400', contentTypeFor(extensionOf(a.original_path)));
  res.headers.set('content-disposition', contentDisposition(a.original_file_name));
  return res;
});

mediaRoutes.get('/assets/:id/video/playback', requireAuthOrSharedLink(), async (c) => {
  const a = await loadOwnedAsset(c, c.req.param('id'));
  if (a.type !== 'VIDEO') throw new ImmichError(400, 'Asset is not a video');
  return serve(c, a.original_path, 'private, max-age=86400', contentTypeFor(extensionOf(a.original_path)));
});
