import { Hono, type Context } from 'hono';
import type { AppEnv } from '../app';
import { requireAuth } from '../auth/session';
import { commit, tracked, type Tracked } from '../db/changes';
import { ImmichError } from '../http/errors';
import { assetTypeFor, contentTypeFor, extensionOf } from './media-types';
import { boundaryOf, MultipartError, parseMultipart } from './multipart';
import { toBase64, writeToR2 } from './r2-writer';

export interface ProcessMessage {
  assetId: string;
  /** stream F: reprocess an asset that is already 'ready'. */
  force?: boolean;
}

const VISIBILITIES = ['archive', 'timeline', 'hidden', 'locked'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Sends a processing message; failures are logged because callers cannot fail the request over them. */
export async function enqueueProcess(env: { PROCESS_QUEUE: Queue<ProcessMessage> }, assetId: string): Promise<void> {
  try {
    await env.PROCESS_QUEUE.send({ assetId } satisfies ProcessMessage);
  } catch (err) {
    console.error('failed to enqueue processing', assetId, err);
  }
}

async function discard(bucket: R2Bucket, key: string): Promise<void> {
  try {
    await bucket.delete(key);
  } catch (err) {
    console.error('failed to delete orphaned object', key, err);
  }
}

export const uploadRoutes = new Hono<AppEnv>();

export function originalKey(ownerId: string, assetId: string, ext: string): string {
  return `originals/${ownerId}/${assetId}${ext}`;
}

/** Accepts base64 or hex SHA-1 and returns base64. */
function normaliseChecksum(value: string): string {
  if (/^[0-9a-f]{40}$/i.test(value)) {
    const bytes = new Uint8Array(20);
    for (let i = 0; i < 20; i++) bytes[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
    return toBase64(bytes);
  }
  return value;
}

async function findByChecksum(db: D1Database, ownerId: string, checksum: string) {
  return db
    .prepare('SELECT id, deleted_at, status FROM assets WHERE owner_id = ?1 AND checksum = ?2')
    .bind(ownerId, checksum)
    .first<{ id: string; deleted_at: string | null; status: string }>();
}

async function duplicateResponse(c: Context<AppEnv>, existing: { id: string; status: string }) {
  if (existing.status === 'pending') await enqueueProcess(c.env, existing.id);
  return c.json({ id: existing.id, status: 'duplicate' }, 200);
}

uploadRoutes.post('/assets', requireAuth, async (c) => {
  const { user } = c.get('auth');
  const db = c.env.DB;

  const headerSum = c.req.header('x-immich-checksum');
  if (headerSum) {
    const existing = await findByChecksum(db, user.id, normaliseChecksum(headerSum));
    if (existing) return duplicateResponse(c, existing);
  }

  const length = Number(c.req.header('content-length') ?? 0);
  if (user.quota_bytes !== null && user.usage_bytes + length > user.quota_bytes) {
    throw new ImmichError(400, 'Quota has been exceeded!');
  }
  if (!c.req.raw.body) throw new ImmichError(400, 'Missing body');

  const assetId = crypto.randomUUID();
  const fields: Record<string, string> = {};
  let seenAsset = false;
  let file: { filename: string; key: string; size: number; checksum: string; type: 'IMAGE' | 'VIDEO' } | undefined;

  try {
    await parseMultipart(c.req.raw.body, boundaryOf(c.req.header('content-type') ?? null), {
      field: (name, value) => {
        fields[name] = value;
      },
      file: async (part) => {
        if (part.name !== 'assetData') return; // sidecarData and others are ignored in phase 1
        if (seenAsset) throw new ImmichError(400, 'Only one assetData part is allowed');
        seenAsset = true;
        const type = assetTypeFor(part.filename);
        if (!type) throw new ImmichError(400, `Unsupported file type ${part.filename}`);
        const ext = extensionOf(part.filename);
        const key = originalKey(user.id, assetId, ext);
        const { size, sha1 } = await writeToR2(c.env.MEDIA, key, part.stream, { contentType: contentTypeFor(ext), sizeHint: length > 0 ? length : undefined });
        file = { filename: part.filename, key, size, checksum: toBase64(sha1), type };
      },
    });
  } catch (err) {
    if (file) await discard(c.env.MEDIA, file.key);
    if (err instanceof MultipartError) throw new ImmichError(400, err.message);
    throw err;
  }

  if (!file) throw new ImmichError(400, 'assetData is required');
  if (user.quota_bytes !== null && user.usage_bytes + file.size > user.quota_bytes) {
    await discard(c.env.MEDIA, file.key); // Content-Length can be absent (chunked bodies), so check the real size too
    throw new ImmichError(400, 'Quota has been exceeded!');
  }
  if (!fields.fileCreatedAt || !fields.fileModifiedAt) {
    await discard(c.env.MEDIA, file.key);
    throw new ImmichError(400, 'fileCreatedAt and fileModifiedAt are required');
  }

  if (Number.isNaN(Date.parse(fields.fileCreatedAt)) || Number.isNaN(Date.parse(fields.fileModifiedAt))) {
    await discard(c.env.MEDIA, file.key);
    throw new ImmichError(400, 'fileCreatedAt and fileModifiedAt must be valid dates');
  }
  const visibility = fields.visibility ?? 'timeline';
  if (!VISIBILITIES.includes(visibility)) {
    await discard(c.env.MEDIA, file.key);
    throw new ImmichError(400, 'Invalid visibility');
  }
  const liveId = fields.livePhotoVideoId || null;
  let hideVideo = false;
  if (liveId) {
    const video = UUID_RE.test(liveId)
      ? await db
          .prepare('SELECT type, owner_id, visibility FROM assets WHERE id = ?1')
          .bind(liveId)
          .first<{ type: string; owner_id: string; visibility: string }>()
      : null;
    if (!video || video.type !== 'VIDEO' || video.owner_id !== user.id) {
      await discard(c.env.MEDIA, file.key);
      throw new ImmichError(400, 'Invalid livePhotoVideoId');
    }
    hideVideo = video.visibility === 'timeline';
  }
  const now = new Date().toISOString();
  const createdAt = new Date(fields.fileCreatedAt).toISOString();
  const duration = fields.duration ? parseDuration(fields.duration) : null;
  const items: Array<Tracked | D1PreparedStatement> = [
    tracked(
      `INSERT INTO assets (id, owner_id, device_asset_id, device_id, type, original_path, original_file_name, checksum,
         file_created_at, file_modified_at, local_date_time, duration, is_favorite, visibility, live_photo_video_id,
         file_size, created_at, updated_at, update_id)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?9, ?11, ?12, ?13, ?14, ?15, ?16, ?16, :cursor
       WHERE (SELECT quota_bytes IS NULL OR usage_bytes + ?15 <= quota_bytes FROM users WHERE id = ?2)`,
      assetId,
      user.id,
      fields.deviceAssetId ?? `web-${file.filename}-${Date.now()}`,
      fields.deviceId ?? 'WEB',
      file.type,
      file.key,
      fields.filename ?? file.filename,
      file.checksum,
      createdAt,
      new Date(fields.fileModifiedAt).toISOString(),
      duration,
      fields.isFavorite === 'true' ? 1 : 0,
      visibility,
      liveId,
      file.size,
      now,
    ),
    db
      .prepare('UPDATE users SET usage_bytes = usage_bytes + ?1 WHERE id = ?2 AND EXISTS (SELECT 1 FROM assets WHERE id = ?3)')
      .bind(file.size, user.id, assetId),
  ];
  if (hideVideo) {
    items.push(
      tracked(
        `UPDATE assets SET visibility = 'hidden', updated_at = ?1, update_id = :cursor
         WHERE id = ?2 AND EXISTS (SELECT 1 FROM assets WHERE id = ?3)`,
        now,
        liveId,
        assetId,
      ),
    );
  }
  let results: D1Result[];
  try {
    results = await commit(db, items);
  } catch (err) {
    // D1 can report failure after committing, so only delete the original once the row is known to be absent.
    let landed = false;
    try {
      landed = Boolean(await db.prepare('SELECT status FROM assets WHERE id = ?1').bind(assetId).first());
    } catch (lookupErr) {
      console.error('could not verify failed insert', assetId, lookupErr);
      throw err; // unknown outcome: keep the object rather than risk deleting a committed original
    }
    if (landed) {
      await enqueueProcess(c.env, assetId);
      return c.json({ id: assetId, status: 'created' }, 201);
    }
    await discard(c.env.MEDIA, file.key);
    if (String(err).includes('UNIQUE')) {
      const existing = await findByChecksum(db, user.id, file.checksum);
      if (existing) return duplicateResponse(c, existing);
    }
    throw err;
  }
  // results[0] is the seq bump, results[1] the insert
  if (results[1].meta.changes === 0) {
    await discard(c.env.MEDIA, file.key);
    throw new ImmichError(400, 'Quota has been exceeded!');
  }

  await enqueueProcess(c.env, assetId);
  return c.json({ id: assetId, status: 'created' }, 201);
});

/** Immich clients send duration as "H:MM:SS.ffffff" or as milliseconds; stored as milliseconds. */
function parseDuration(value: string): number | null {
  if (/^\d+$/.test(value)) return Number(value);
  const m = value.match(/^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/);
  if (!m) return null;
  return Math.round((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000);
}

uploadRoutes.post('/assets/bulk-upload-check', requireAuth, async (c) => {
  const { user } = c.get('auth');
  const body = await c.req.json().catch(() => null);
  const assets = (body as { assets?: Array<{ id: string; checksum: string }> } | null)?.assets;
  if (
    !Array.isArray(assets) ||
    !assets.every((a) => a && typeof a.id === 'string' && typeof a.checksum === 'string')
  ) {
    throw new ImmichError(400, 'assets must be an array of {id, checksum}');
  }
  if (assets.length > 900) throw new ImmichError(400, 'Too many assets in one check');
  const results = [];
  for (const item of assets) {
    const existing = await findByChecksum(c.env.DB, user.id, normaliseChecksum(item.checksum));
    results.push(
      existing
        ? { id: item.id, action: 'reject' as const, reason: 'duplicate' as const, assetId: existing.id, isTrashed: existing.deleted_at !== null }
        : { id: item.id, action: 'accept' as const },
    );
  }
  return c.json({ results });
});
