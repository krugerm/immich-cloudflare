import { Hono, type Context } from 'hono';
import { setCookie } from 'hono/cookie';
import type { AppEnv } from '../app';
import { shareableAssetIds } from '../access/assets';
import { jsonObject, optBool, optEnum, optNullableString, optUuid, uuid, uuidArray } from '../albums/input';
import { getAlbum, mapAlbums, requireAlbumAccess } from '../albums/repo';
import { mapAssetResponse } from '../assets/map';
import { hashPassword, verifyPassword } from '../auth/password';
import { requireAuth } from '../auth/session';
import type { AssetRow, ExifRow } from '../db/rows';
import type { Dto } from '../gen/dto';
import { ImmichError } from '../http/errors';
import {
  cookieTokens,
  getSharedLink,
  hasPasswordToken,
  passwordToken,
  requireAuthOrSharedLink,
  SHARED_LINK_TOKEN_COOKIE,
  toBase64Url,
  type SharedLinkRow,
} from './auth';

export const sharedLinkRoutes = new Hono<AppEnv>();

/** Reported as `password` when a link has one; sending it back in PATCH keeps the stored password. */
export const PASSWORD_SET = '********';

type AssetIdResult = Dto<'AssetIdsResponseDto'>;

/** Immich: 50 random bytes, returned as base64url. */
const newShareKey = () => toBase64Url(crypto.getRandomValues(new Uint8Array(50)));

function optDate(v: unknown, name: string): string | null | undefined {
  if (v === undefined || v === null) return v;
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw new ImmichError(400, `${name} must be an ISO date`);
  return new Date(v).toISOString();
}

/** Immich mapSharedLink. `limitAssets` mirrors getAll, which loads one asset per link. */
async function mapSharedLink(
  db: D1Database,
  link: SharedLinkRow,
  opts: { stripMetadata?: boolean; limitAssets?: number } = {},
): Promise<Dto<'SharedLinkResponseDto'>> {
  const { results } = await db
    .prepare(
      `SELECT a.*, ${EXIF_COLUMNS} FROM shared_link_assets s JOIN assets a ON a.id = s.asset_id AND a.deleted_at IS NULL AND a.visibility != 'locked'
       LEFT JOIN asset_exif e ON e.asset_id = a.id WHERE s.shared_link_id = ?1 ORDER BY a.file_created_at ASC LIMIT ?2`,
    )
    .bind(link.id, opts.limitAssets ?? -1)
    .all<Record<string, any>>();
  const assets = results.map((r) => {
    const { asset, exif } = splitAssetExif(r);
    // C4: Immich mapSharedLink maps assets without auth, so isFavorite (`auth.user.id === ownerId && …`) is always false
    const full = { ...mapAssetResponse(asset, exif), isFavorite: false };
    if (!opts.stripMetadata) return full;
    const { id, type, originalMimeType, thumbhash, localDateTime, duration, livePhotoVideoId, width, height } = full;
    return { id, type, originalMimeType, thumbhash, localDateTime, duration, livePhotoVideoId, hasMetadata: false, width, height } as Dto<'AssetResponseDto'>;
  });
  const albumRow = link.album_id ? await getAlbum(db, link.album_id) : null;
  const album = albumRow ? (await mapAlbums(db, [albumRow], link.user_id, { forceShared: true }))[0] : undefined;
  return {
    id: link.id,
    description: link.description,
    password: link.password_hash ? PASSWORD_SET : null,
    userId: link.user_id,
    key: link.key,
    type: link.type,
    createdAt: link.created_at,
    expiresAt: link.expires_at,
    assets,
    album,
    allowUpload: link.allow_upload === 1,
    allowDownload: link.allow_download === 1,
    showMetadata: link.show_metadata === 1,
    slug: link.slug,
  };
}

const EXIF_FIELDS = [
  'make', 'model', 'lens_model', 'exposure_time', 'f_number', 'focal_length', 'iso', 'latitude', 'longitude', 'city', 'state', 'country',
  'date_time_original', 'modify_date', 'time_zone', 'orientation', 'rating', 'description', 'exif_image_width', 'exif_image_height',
  'file_size_in_byte', 'profile_description', 'projection_type', 'fps',
];
const EXIF_COLUMNS = ['e.asset_id AS e_asset_id', ...EXIF_FIELDS.map((f) => `e.${f} AS e_${f}`)].join(', ');

function splitAssetExif(row: Record<string, any>): { asset: AssetRow; exif: ExifRow | null } {
  const asset: Record<string, any> = {};
  const exif: Record<string, any> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith('e_')) exif[k.slice(2)] = v;
    else asset[k] = v;
  }
  return { asset: asset as AssetRow, exif: exif.asset_id ? ({ ...exif, owner_id: asset.owner_id } as ExifRow) : null };
}

async function findOrFail(db: D1Database, userId: string, id: string): Promise<SharedLinkRow> {
  const link = await db.prepare('SELECT * FROM shared_links WHERE id = ?1 AND user_id = ?2').bind(id, userId).first<SharedLinkRow>();
  if (!link) throw new ImmichError(400, 'Shared link not found');
  return link;
}

async function linkAssetIds(db: D1Database, linkId: string): Promise<Set<string>> {
  const { results } = await db.prepare('SELECT asset_id FROM shared_link_assets WHERE shared_link_id = ?1').bind(linkId).all<{ asset_id: string }>();
  return new Set(results.map((r) => r.asset_id));
}

const isUniqueViolation = (err: unknown) => String((err as Error)?.message ?? err).includes('UNIQUE constraint failed: shared_links.slug');

sharedLinkRoutes.get('/shared-links', requireAuth, async (c) => {
  const db = c.env.DB;
  const albumId = optUuid(c.req.query('albumId'), 'albumId');
  const id = optUuid(c.req.query('id'), 'id');
  const where = ['user_id = ?1'];
  const binds: unknown[] = [c.get('auth').user.id];
  if (albumId) {
    binds.push(albumId);
    where.push(`album_id = ?${binds.length}`);
  }
  if (id) {
    binds.push(id);
    where.push(`id = ?${binds.length}`);
  }
  const { results } = await db.prepare(`SELECT * FROM shared_links WHERE ${where.join(' AND ')} ORDER BY created_at DESC`).bind(...binds).all<SharedLinkRow>();
  const out = [];
  for (const link of results) out.push(await mapSharedLink(db, link, { limitAssets: 1 }));
  return c.json(out);
});

sharedLinkRoutes.get('/shared-links/me', requireAuthOrSharedLink({ skipPassword: true }), async (c) => {
  const shared = getSharedLink(c);
  if (!shared) throw new ImmichError(403, 'Forbidden');
  if (!(await hasPasswordToken(c, shared.link))) throw new ImmichError(401, 'Password required');
  return c.json(await mapSharedLink(c.env.DB, shared.link, { stripMetadata: !shared.link.show_metadata }));
});

sharedLinkRoutes.post('/shared-links/login', requireAuthOrSharedLink({ skipPassword: true }), async (c) => {
  const shared = getSharedLink(c);
  if (!shared) throw new ImmichError(403, 'Forbidden');
  const body = await jsonObject(c);
  if (typeof body.password !== 'string') throw new ImmichError(400, 'password must be a string');
  const { link } = shared;
  if (!link.password_hash) throw new ImmichError(400, 'Shared link is not password protected');
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  if (!(await c.env.LOGIN_LIMITER.limit({ key: `shared-link:${link.id}|${ip}` })).success) throw new ImmichError(429, 'Too many login attempts');
  if (!(await verifyPassword(body.password, link.password_hash))) throw new ImmichError(401, 'Invalid password');
  const token = await passwordToken(link);
  const tokens = cookieTokens(c);
  if (!tokens.includes(token)) tokens.push(token);
  setCookie(c, SHARED_LINK_TOKEN_COOKIE, tokens.join(','), { path: '/', sameSite: 'Lax', secure: true, httpOnly: true, maxAge: 86_400 });
  return c.json(await mapSharedLink(c.env.DB, link, { stripMetadata: !link.show_metadata }), 201);
});

sharedLinkRoutes.get('/shared-links/:id', requireAuth, async (c) => {
  const id = uuid(c.req.param('id'), 'id');
  return c.json(await mapSharedLink(c.env.DB, await findOrFail(c.env.DB, c.get('auth').user.id, id)));
});

sharedLinkRoutes.post('/shared-links', requireAuth, async (c) => {
  const db = c.env.DB;
  const userId = c.get('auth').user.id;
  const body = await jsonObject(c);
  const type = optEnum(body.type, 'type', ['ALBUM', 'INDIVIDUAL'] as const);
  if (!type) throw new ImmichError(400, 'type is required');
  const albumId = optUuid(body.albumId, 'albumId');
  const assetIds = body.assetIds === undefined ? [] : uuidArray(body.assetIds, 'assetIds');
  const description = optNullableString(body.description, 'description');
  const password = optNullableString(body.password, 'password');
  const slug = optNullableString(body.slug, 'slug');
  const expiresAt = optDate(body.expiresAt, 'expiresAt');
  const allowUpload = optBool(body.allowUpload, 'allowUpload');
  const allowDownload = optBool(body.allowDownload, 'allowDownload');
  const showMetadata = optBool(body.showMetadata, 'showMetadata');
  if (type === 'ALBUM') {
    if (!albumId) throw new ImmichError(400, 'albumId is required for type ALBUM');
    if (assetIds.length) throw new ImmichError(400, 'assetIds can only be used with type INDIVIDUAL');
    await requireAlbumAccess(c, albumId, 'share');
  } else {
    if (assetIds.length === 0) throw new ImmichError(400, 'assetIds are required for type INDIVIDUAL');
    if (albumId) throw new ImmichError(400, 'albumId can only be used with type ALBUM');
    const allowed = await shareableAssetIds(db, userId, assetIds);
    if (!assetIds.every((a) => allowed.has(a))) throw new ImmichError(400, 'Not found or no asset.share access');
  }
  const link: SharedLinkRow = {
    id: crypto.randomUUID(),
    user_id: userId,
    key: newShareKey(),
    slug: slug || null,
    type,
    album_id: albumId ?? null,
    description: description || null,
    password_hash: password ? await hashPassword(password) : null,
    expires_at: expiresAt ?? null,
    allow_upload: (allowUpload ?? true) ? 1 : 0,
    allow_download: showMetadata !== false && (allowDownload ?? true) ? 1 : 0,
    show_metadata: (showMetadata ?? true) ? 1 : 0,
    created_at: new Date().toISOString(),
  };
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO shared_links (id, user_id, key, slug, type, album_id, description, password_hash, expires_at, allow_upload, allow_download, show_metadata, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
        )
        .bind(link.id, link.user_id, link.key, link.slug, link.type, link.album_id, link.description, link.password_hash, link.expires_at, link.allow_upload, link.allow_download, link.show_metadata, link.created_at),
      db.prepare('INSERT OR IGNORE INTO shared_link_assets (shared_link_id, asset_id) SELECT ?1, value FROM json_each(?2)').bind(link.id, JSON.stringify(assetIds)),
    ]);
  } catch (err) {
    if (isUniqueViolation(err)) throw new ImmichError(400, 'Failed to save shared link');
    throw err;
  }
  return c.json(await mapSharedLink(db, link), 201);
});

sharedLinkRoutes.patch('/shared-links/:id', requireAuth, async (c) => {
  const db = c.env.DB;
  const id = uuid(c.req.param('id'), 'id');
  const body = await jsonObject(c);
  const description = optNullableString(body.description, 'description');
  const password = optNullableString(body.password, 'password');
  const slug = optNullableString(body.slug, 'slug');
  const expiresAt = optDate(body.expiresAt, 'expiresAt');
  const allowUpload = optBool(body.allowUpload, 'allowUpload');
  const allowDownload = optBool(body.allowDownload, 'allowDownload');
  const showMetadata = optBool(body.showMetadata, 'showMetadata');
  const link = await findOrFail(db, c.get('auth').user.id, id);
  if (description !== undefined) link.description = description;
  if (password !== undefined && password !== PASSWORD_SET) link.password_hash = password ? await hashPassword(password) : null;
  link.slug = slug || null; // Immich: `slug: dto.slug || null`
  if (expiresAt !== undefined) link.expires_at = expiresAt;
  if (allowUpload !== undefined) link.allow_upload = allowUpload ? 1 : 0;
  if (allowDownload !== undefined) link.allow_download = allowDownload ? 1 : 0;
  if (showMetadata !== undefined) link.show_metadata = showMetadata ? 1 : 0;
  try {
    await db
      .prepare(
        `UPDATE shared_links SET description = ?2, password_hash = ?3, slug = ?4, expires_at = ?5, allow_upload = ?6, allow_download = ?7, show_metadata = ?8 WHERE id = ?1`,
      )
      .bind(id, link.description, link.password_hash, link.slug, link.expires_at, link.allow_upload, link.allow_download, link.show_metadata)
      .run();
  } catch (err) {
    if (isUniqueViolation(err)) throw new ImmichError(400, 'Failed to save shared link');
    throw err;
  }
  return c.json(await mapSharedLink(db, link));
});

sharedLinkRoutes.delete('/shared-links/:id', requireAuth, async (c) => {
  const id = uuid(c.req.param('id'), 'id');
  await findOrFail(c.env.DB, c.get('auth').user.id, id);
  await c.env.DB.prepare('DELETE FROM shared_links WHERE id = ?1').bind(id).run();
  return c.body(null, 204);
});

async function individualLink(c: Context<AppEnv>) {
  const id = uuid(c.req.param('id'), 'id');
  const assetIds = uuidArray((await jsonObject(c)).assetIds, 'assetIds');
  const link = await findOrFail(c.env.DB, c.get('auth').user.id, id);
  if (link.type !== 'INDIVIDUAL') throw new ImmichError(400, 'Invalid shared link type');
  return { link, assetIds };
}

sharedLinkRoutes.put('/shared-links/:id/assets', requireAuth, async (c) => {
  const db = c.env.DB;
  const { link, assetIds } = await individualLink(c);
  const existing = await linkAssetIds(db, link.id);
  const allowed = await shareableAssetIds(db, c.get('auth').user.id, assetIds.filter((a) => !existing.has(a)));
  const results: AssetIdResult[] = assetIds.map((assetId) =>
    existing.has(assetId)
      ? { assetId, success: false, error: 'duplicate' }
      : allowed.has(assetId)
        ? { assetId, success: true }
        : { assetId, success: false, error: 'no_permission' },
  );
  const added = results.filter((r) => r.success).map((r) => r.assetId);
  if (added.length) {
    await db.prepare('INSERT OR IGNORE INTO shared_link_assets (shared_link_id, asset_id) SELECT ?1, value FROM json_each(?2)').bind(link.id, JSON.stringify(added)).run();
  }
  return c.json(results);
});

sharedLinkRoutes.delete('/shared-links/:id/assets', requireAuth, async (c) => {
  const db = c.env.DB;
  const { link, assetIds } = await individualLink(c);
  const existing = await linkAssetIds(db, link.id);
  const results: AssetIdResult[] = assetIds.map((assetId) => {
    if (!existing.has(assetId)) return { assetId, success: false, error: 'not_found' };
    existing.delete(assetId);
    return { assetId, success: true };
  });
  const removed = results.filter((r) => r.success).map((r) => r.assetId);
  if (removed.length) {
    await db.prepare('DELETE FROM shared_link_assets WHERE shared_link_id = ?1 AND asset_id IN (SELECT value FROM json_each(?2))').bind(link.id, JSON.stringify(removed)).run();
  }
  return c.json(results);
});
