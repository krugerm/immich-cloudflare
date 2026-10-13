import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AppEnv } from '../app';
import { requireAuth, sha256Hex } from '../auth/session';
import type { UserRow } from '../db/rows';
import { ImmichError } from '../http/errors';

export interface SharedLinkRow {
  id: string;
  user_id: string;
  /** Share key, unpadded base64url. */
  key: string;
  slug: string | null;
  type: 'ALBUM' | 'INDIVIDUAL';
  album_id: string | null;
  description: string | null;
  password_hash: string | null;
  expires_at: string | null;
  allow_upload: number;
  allow_download: number;
  show_metadata: number;
  created_at: string;
}

export interface SharedLinkAuth {
  link: SharedLinkRow;
  owner: UserRow;
}

export const SHARED_LINK_TOKEN_COOKIE = 'immich_shared_link_token';

// Requests authenticated by a share key or slug; kept off AppEnv so the shared Variables type stays unchanged.
const byRequest = new WeakMap<Request, SharedLinkAuth>();

export function getSharedLink(c: Context<AppEnv>): SharedLinkAuth | undefined {
  return byRequest.get(c.req.raw);
}

export function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The stored (unpadded base64url) form of a share key. Immich decodes keys as hex when they are 100 characters long,
 * otherwise as base64url; both forms of the same bytes map to one stored key. Returns null for malformed input.
 */
export function canonicalShareKey(key: string): string | null {
  if (key.length === 100 && /^[0-9a-f]+$/i.test(key)) return toBase64Url(new Uint8Array(key.match(/../g)!.map((h) => parseInt(h, 16))));
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(key)) return null;
  const b64 = key.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  try {
    return toBase64Url(Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (ch) => ch.charCodeAt(0)));
  } catch {
    return null;
  }
}

function sameKey(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  return x.length === y.length && crypto.subtle.timingSafeEqual(x, y);
}

const LINK_WITH_OWNER = `SELECT l.id AS l_id, l.user_id AS l_user_id, l.key AS l_key, l.slug, l.type, l.album_id, l.description AS l_description,
  l.password_hash AS l_password_hash, l.expires_at, l.allow_upload, l.allow_download, l.show_metadata, l.created_at AS l_created_at, u.*
  FROM shared_links l JOIN users u ON u.id = l.user_id AND u.deleted_at IS NULL`;

function splitRow(row: Record<string, any>): SharedLinkAuth {
  const link: SharedLinkRow = {
    id: row.l_id,
    user_id: row.l_user_id,
    key: row.l_key,
    slug: row.slug,
    type: row.type,
    album_id: row.album_id,
    description: row.l_description,
    password_hash: row.l_password_hash,
    expires_at: row.expires_at,
    allow_upload: row.allow_upload,
    allow_download: row.allow_download,
    show_metadata: row.show_metadata,
    created_at: row.l_created_at,
  };
  const { l_id, l_user_id, l_key, slug, type, album_id, l_description, l_password_hash, expires_at, allow_upload, allow_download, show_metadata, l_created_at, ...owner } =
    row;
  return { link, owner: owner as UserRow };
}

const isValid = (a: SharedLinkAuth | null) => !!a && (!a.link.expires_at || Date.parse(a.link.expires_at) > Date.now());

/**
 * Immich AuthService.validate order: share key (header, then `?key=`), then share slug (header, then `?slug=`).
 * Returns null when the request carries neither; throws 401 for an unknown or expired link.
 */
export async function resolveSharedLink(db: D1Database, req: Request): Promise<SharedLinkAuth | null> {
  const url = new URL(req.url);
  const key = req.headers.get('x-immich-share-key') || url.searchParams.get('key');
  const slug = req.headers.get('x-immich-share-slug') || url.searchParams.get('slug');
  if (key) {
    // Indexed equality lookup as in Immich (`getByKey`), then a constant-time check of the stored value.
    const canonical = canonicalShareKey(key);
    const row = canonical ? await db.prepare(`${LINK_WITH_OWNER} WHERE l.key = ?1`).bind(canonical).first<Record<string, any>>() : null;
    const auth = row && sameKey(row.l_key, canonical!) ? splitRow(row) : null;
    if (!isValid(auth)) throw new ImmichError(401, 'Invalid share key');
    return auth;
  }
  if (slug) {
    const row = await db.prepare(`${LINK_WITH_OWNER} WHERE l.slug = ?1`).bind(slug).first<Record<string, any>>();
    const auth = row ? splitRow(row) : null;
    if (!isValid(auth)) throw new ImmichError(401, 'Invalid share slug');
    return auth;
  }
  return null;
}

/** The cookie token proving the password was entered: base64(sha256("<id>-<password hash>")). */
export async function passwordToken(link: SharedLinkRow): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${link.id}-${link.password_hash}`));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

export function cookieTokens(c: Context<AppEnv>): string[] {
  return getCookie(c, SHARED_LINK_TOKEN_COOKIE)?.split(',').filter(Boolean) ?? [];
}

export async function hasPasswordToken(c: Context<AppEnv>, link: SharedLinkRow): Promise<boolean> {
  return !link.password_hash || cookieTokens(c).includes(await passwordToken(link));
}

/**
 * Immich `@Authenticated({ sharedLink: true })`: a share key or slug authenticates as the link, otherwise a session is required.
 * Unless `skipPassword`, a password-protected link also needs the cookie token set by `POST /shared-links/login`.
 */
export function requireAuthOrSharedLink(opts: { skipPassword?: boolean } = {}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const shared = await resolveSharedLink(c.env.DB, c.req.raw);
    if (!shared) return requireAuth(c, next);
    if (!opts.skipPassword && !(await hasPasswordToken(c, shared.link))) throw new ImmichError(401, 'Password required');
    byRequest.set(c.req.raw, shared);
    await next();
  };
}
