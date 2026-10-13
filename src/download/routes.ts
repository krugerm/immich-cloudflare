import { Hono, type Context } from 'hono';
import type { AppEnv } from '../app';
import { allowLocked, isUuid, requireAssetAccess } from '../assets/access';
import { badRequest } from '../assets/update';
import { requireAuth } from '../auth/session';
import type { AssetRow } from '../db/rows';
import { ImmichError } from '../http/errors';
import { ENTRY_OVERHEAD, fitsZip, zipLimits, zipStream, type ZipEntry } from './zip';

export const downloadRoutes = new Hono<AppEnv>();

const DEFAULT_ARCHIVE_SIZE = 4 * 1024 ** 3;
const PAGE = 5000;
const IN_CHUNK = 90;

/** Immich uses sanitize-filename: path separators, control characters and reserved characters go. */
export function sanitizeFilename(name: string): string {
  const clean = name.replace(/[\/\\?<>:*|"\u0000-\u001f\u0080-\u009f]/g, '').replace(/^\.+$/, '').replace(/[. ]+$/, '');
  let out = '';
  for (const ch of clean) {
    if (out.length + ch.length > 255) break; // whole code points only: never split a surrogate pair
    out += ch;
  }
  return out;
}

/** `unnamed`, then `name+1.ext`, `name+2.ext` for repeats, as Immich names duplicate files. */
export function uniqueName(name: string, used: Map<string, number>): string {
  const base = sanitizeFilename(name) || 'unnamed';
  const count = used.get(base) ?? 0;
  used.set(base, count + 1);
  if (count === 0) return base;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? `${base.slice(0, dot)}+${count}${base.slice(dot)}` : `${base}+${count}`;
}

async function readBody(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  const type = c.req.header('content-type') ?? '';
  if (type.includes('application/x-www-form-urlencoded')) {
    const form = new URLSearchParams(new TextDecoder().decode(await c.req.arrayBuffer()));
    return { assetIds: form.getAll('assetIds').flatMap((v) => v.split(',')).filter(Boolean), edited: form.get('edited') ?? undefined, archiveName: form.get('archiveName') ?? undefined };
  }
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Request body must be a JSON object');
  const o = body as Record<string, unknown>;
  if (typeof o.assetIds === 'string') o.assetIds = o.assetIds.split(',');
  return o;
}

interface SizedAsset {
  id: string;
  live_photo_video_id: string | null;
  file_size: number;
}

/** `includeLocked` comes from allowLocked (a PIN-elevated session); callers have already checked access. */
async function byIds(db: D1Database, ids: string[], includeLocked: boolean): Promise<Map<string, SizedAsset>> {
  const out = new Map<string, SizedAsset>();
  const lockedSql = includeLocked ? '' : "AND visibility <> 'locked' ";
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    const { results } = await db
      .prepare(`SELECT id, live_photo_video_id, file_size FROM assets WHERE deleted_at IS NULL ${lockedSql}AND id IN (${chunk.map((_, n) => `?${n + 1}`).join(',')})`)
      .bind(...chunk)
      .all<SizedAsset>();
    for (const r of results) out.set(r.id, r);
  }
  return out;
}

downloadRoutes.post('/download/info', requireAuth, async (c) => {
  const body = await readBody(c);
  const user = c.get('auth').user;
  if (body.archiveSize !== undefined && (!Number.isInteger(body.archiveSize) || (body.archiveSize as number) < 1)) throw badRequest('archiveSize must be a positive integer');
  for (const k of ['albumId', 'userId'] as const) if (body[k] !== undefined && !isUuid(body[k])) throw badRequest(`${k} must be a UUID`);

  let assets: SizedAsset[];
  if (Array.isArray(body.assetIds)) {
    if (!body.assetIds.every(isUuid)) throw badRequest('assetIds must be an array of UUIDs');
    const ids = [...new Set(body.assetIds as string[])];
    await requireAssetAccess(c, ids, 'download');
    const rows = await byIds(c.env.DB, ids, allowLocked(c));
    assets = ids.flatMap((id) => rows.get(id) ?? []);
  } else if (body.albumId) {
    throw badRequest('Not found or no album.download access');
  } else if (body.userId) {
    if (body.userId !== user.id) throw badRequest('Not found or no timeline.download access');
    assets = [];
    for (let offset = 0; ; offset += PAGE) {
      const { results } = await c.env.DB.prepare(
        `SELECT id, live_photo_video_id, file_size FROM assets WHERE owner_id = ?1 AND deleted_at IS NULL AND visibility NOT IN ('hidden', 'locked')
         ORDER BY local_date_time DESC, id LIMIT ?2 OFFSET ?3`,
      )
        .bind(user.id, PAGE, offset)
        .all<SizedAsset>();
      assets.push(...results);
      if (results.length < PAGE) break;
    }
  } else {
    throw badRequest('assetIds, albumId, or userId is required');
  }

  // Every archive handed out must be accepted by /download/archive, so the target is clamped to what one ZIP can hold.
  const zipRoom = zipLimits.maxBytes - zipLimits.maxEntries * ENTRY_OVERHEAD - 22;
  const target = Math.min((body.archiveSize as number | undefined) || DEFAULT_ARCHIVE_SIZE, zipRoom);
  const archives: Array<{ size: number; assetIds: string[] }> = [];
  let archive = { size: 0, assetIds: [] as string[] };
  const add = (a: { id: string; file_size: number }) => {
    const size = Number(a.file_size || 0);
    // Close the archive before the asset that would overflow it; an oversized asset gets an archive of its own.
    if (archive.assetIds.length > 0 && (archive.assetIds.length >= zipLimits.maxEntries || archive.size + size > target || !fitsZip(archive.size + size, archive.assetIds.length + 1))) {
      archives.push(archive);
      archive = { size: 0, assetIds: [] };
    }
    archive.assetIds.push(a.id);
    archive.size += size;
  };
  const motionIds = new Set<string>();
  for (const a of assets) {
    if (a.live_photo_video_id) motionIds.add(a.live_photo_video_id);
    add(a);
  }
  if (motionIds.size > 0) {
    const motion = await byIds(c.env.DB, [...motionIds], allowLocked(c));
    for (const m of motion.values()) add(m);
  }
  if (archive.assetIds.length > 0) archives.push(archive);
  return c.json({ totalSize: archives.reduce((sum, a) => sum + a.size, 0), archives }, 201);
});

downloadRoutes.post('/download/archive', requireAuth, async (c) => {
  const body = await readBody(c);
  if (!Array.isArray(body.assetIds) || !body.assetIds.every(isUuid)) throw badRequest('assetIds must be an array of UUIDs');
  if (body.archiveName !== undefined && typeof body.archiveName !== 'string') throw badRequest('archiveName must be a string');
  const ids = body.assetIds as string[];
  const assets = await requireAssetAccess(c, ids, 'download');
  const ordered: AssetRow[] = [...new Set(ids)].map((id) => assets.get(id)!);
  if (ordered.length > zipLimits.maxEntries) throw new ImmichError(400, 'Too many assets for one archive; request /download/info and download each archive separately');
  if (!fitsZip(ordered.reduce((sum, a) => sum + a.file_size, 0), ordered.length)) {
    throw new ImmichError(400, 'Archive is too large; request /download/info and download each archive separately');
  }
  const used = new Map<string, number>();
  const entries: ZipEntry[] = ordered.map((a) => ({
    name: uniqueName(a.original_file_name, used),
    modified: new Date(a.file_modified_at),
    open: async () => (await c.env.MEDIA.get(a.original_path))?.body ?? null,
  }));
  const headers = new Headers({ 'content-type': 'application/octet-stream', 'cache-control': 'no-store' });
  if (body.archiveName) headers.set('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(body.archiveName as string)}.zip`);
  return new Response(zipStream(entries), { headers });
});
