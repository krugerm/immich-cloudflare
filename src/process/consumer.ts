import { commit, tracked } from '../db/changes';
import type { AssetRow } from '../db/rows';
import { extensionOf } from '../upload/media-types';
import type { ProcessMessage } from '../upload/routes';
import { emitUploadReady } from '../realtime/emit'; // stream H
import { extractExif, localDateTime, type ExtractedExif } from './exif';
import { imagesThumbnailer, MAX_THUMBNAIL_INPUT, THUMBNAIL_INPUTS, thumbhashFromPng, thumbKey, type Thumbnailer } from './thumbs';
import { containerProcessor } from '../container/client'; // phase 3 stream B
import type { MediaProcessor } from '../container/contract';
import { enqueueMl } from '../ml/job'; // phase 4
import { enrichGeo } from '../geo/enrich'; // phase 4 stream F
import { processLargeImage } from './large-image'; // phase 3 stream D
import { processVideo } from './video'; // phase 3 stream C

/** Columns the user edited (asset_exif.locked_properties) survive re-extraction, as in Immich. */
const keepLocked = (property: string, column: string) =>
  `CASE WHEN instr(COALESCE(asset_exif.locked_properties, ''), '"${property}"') > 0 THEN asset_exif.${column} ELSE excluded.${column} END`;

/** The place follows the coordinates: a hand-edited (locked) location, or a run without geocoding (?26 = 0), keeps the stored place. */
const keepPlace = (column: string) =>
  `CASE WHEN ?26 = 0 OR instr(COALESCE(asset_exif.locked_properties, ''), '"latitude"') > 0 OR instr(COALESCE(asset_exif.locked_properties, ''), '"longitude"') > 0 THEN asset_exif.${column} ELSE excluded.${column} END`;

export function exifStatement(a: AssetRow, e: ExtractedExif) {
  return tracked(
    `INSERT INTO asset_exif (asset_id, owner_id, make, model, lens_model, exposure_time, f_number, focal_length, iso,
       latitude, longitude, date_time_original, modify_date, time_zone, orientation, rating, description,
       exif_image_width, exif_image_height, file_size_in_byte, profile_description, projection_type, city, state, country, update_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, :cursor)
     ON CONFLICT (asset_id) DO UPDATE SET make = excluded.make, model = excluded.model, lens_model = excluded.lens_model,
       exposure_time = excluded.exposure_time, f_number = excluded.f_number, focal_length = excluded.focal_length,
       iso = excluded.iso, latitude = ${keepLocked('latitude', 'latitude')}, longitude = ${keepLocked('longitude', 'longitude')},
       date_time_original = ${keepLocked('dateTimeOriginal', 'date_time_original')}, modify_date = excluded.modify_date,
       time_zone = ${keepLocked('timeZone', 'time_zone')},
       orientation = excluded.orientation, rating = ${keepLocked('rating', 'rating')}, description = ${keepLocked('description', 'description')},
       exif_image_width = excluded.exif_image_width, exif_image_height = excluded.exif_image_height,
       file_size_in_byte = excluded.file_size_in_byte, profile_description = excluded.profile_description,
       projection_type = excluded.projection_type,
       city = ${keepPlace('city')}, state = ${keepPlace('state')}, country = ${keepPlace('country')},
       update_id = excluded.update_id`,
    a.id, a.owner_id, e.make, e.model, e.lensModel, e.exposureTime, e.fNumber, e.focalLength, e.iso,
    e.latitude, e.longitude, e.dateTimeOriginal ?? a.file_created_at, a.file_modified_at, e.timeZone, e.orientation, e.rating, e.description,
    e.exifImageWidth, e.exifImageHeight, a.file_size, e.profileDescription, e.projectionType,
    e.city ?? null, e.state ?? null, e.country ?? null, e.city === undefined ? 0 : 1,
  );
}

/** Queues a backup copy; send failures are logged because the weekly requeue sweep catches misses. */
export async function enqueueBackup(env: Env, assetId: string): Promise<void> {
  try {
    await env.BACKUP_QUEUE.send({ assetId });
  } catch (err) {
    console.error('failed to enqueue backup', assetId, err);
  }
}

/** Leaves the asset for the media container (none configured, or not built for this type yet). */
export async function markNeedsMedia(env: Env, a: AssetRow, now: string): Promise<void> {
  await commit(env.DB, [
    tracked(`UPDATE assets SET status = 'needs_media', updated_at = ?2, update_id = :cursor WHERE id = ?1 AND status <> 'ready'`, a.id, now),
  ]);
  await emitUploadReady(env, a.id); // stream H
  await enqueueBackup(env, a.id);
}

/** Marks the asset failed (terminal input error) with EXIF if any was read, and still backs up the original. */
export async function markFailed(env: Env, a: AssetRow, error: string, now: string, exif?: ExtractedExif): Promise<void> {
  await commit(env.DB, [
    ...(exif ? [exifStatement(a, exif)] : []),
    tracked(`UPDATE assets SET status = 'failed', error = ?2, updated_at = ?3, update_id = :cursor WHERE id = ?1 AND status <> 'ready'`, a.id, error.slice(0, 500), now),
  ]);
  await enqueueBackup(env, a.id);
}

/**
 * Writes preview.jpeg and thumbnail.webp from an upright-or-EXIF-oriented image and returns its thumbhash and display
 * size. `orientation` is the EXIF orientation of `bytes` (null when the pixels are already upright).
 */
export async function renderThumbnails(
  env: Env,
  assetId: string,
  bytes: Uint8Array,
  thumbnailer: Thumbnailer,
  orientation: string | null,
): Promise<{ thumbhash: string; width: number; height: number }> {
  const raw = await thumbnailer.info(bytes);
  const swap = orientation !== null && Number(orientation) >= 5;
  const w = swap ? raw.height : raw.width;
  const h = swap ? raw.width : raw.height;
  const shortSide = (size: number) => (w <= h ? { width: size } : { height: size });
  const preview = await thumbnailer.render(bytes, { ...shortSide(1440), format: 'image/jpeg', quality: 80 });
  await env.MEDIA.put(thumbKey(assetId, 'preview'), preview, { httpMetadata: { contentType: 'image/jpeg' } });
  const thumb = await thumbnailer.render(bytes, { ...shortSide(250), format: 'image/webp', quality: 80 });
  await env.MEDIA.put(thumbKey(assetId, 'thumbnail'), thumb, { httpMetadata: { contentType: 'image/webp' } });
  const thumbhash = thumbhashFromPng(await thumbnailer.render(bytes, { width: 100, height: 100, format: 'image/png' }));
  return { thumbhash, width: w, height: h };
}

export async function processAsset(
  env: Env,
  assetId: string,
  thumbnailer: Thumbnailer,
  force = false,
  processor?: MediaProcessor,
): Promise<void> {
  const db = env.DB;
  const a = await db.prepare('SELECT * FROM assets WHERE id = ?1').bind(assetId).first<AssetRow>();
  if (!a || (a.status === 'ready' && !force)) return;
  const now = new Date().toISOString();
  const ext = extensionOf(a.original_path);

  if (a.type !== 'IMAGE' || !THUMBNAIL_INPUTS.has(ext) || a.file_size > MAX_THUMBNAIL_INPUT) {
    if (!processor) return markNeedsMedia(env, a, now);
    if (a.type === 'VIDEO') return processVideo(env, a, thumbnailer, processor, now); // phase 3 stream C
    return processLargeImage(env, a, thumbnailer, processor, now); // phase 3 stream D
  }

  const object = await env.MEDIA.get(a.original_path);
  if (!object) {
    await commit(db, [
      tracked(`UPDATE assets SET status = 'failed', error = 'original missing', updated_at = ?2, update_id = :cursor WHERE id = ?1 AND status <> 'ready'`, a.id, now),
    ]);
    return;
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  const exif = await extractExif(bytes);

  let thumbhash: string;
  let width: number | null = exif.width;
  let height: number | null = exif.height;
  try {
    const r = await renderThumbnails(env, a.id, bytes, thumbnailer, exif.orientation);
    thumbhash = r.thumbhash;
    width ??= r.width;
    height ??= r.height;
  } catch (err) {
    // Only Images input errors (94xx) are terminal; anything else is retried by the queue.
    if (!isImagesInputError(err)) throw err;
    return markFailed(env, a, String(err), now, exif);
  }

  await markReady(env, a, now, { exif, thumbhash, width, height });
}

/**
 * Commits a processed asset: EXIF, status ready, thumbhash, display size, duration (videos) and local_date_time (kept
 * when the user locked dateTimeOriginal), then notifies clients and queues the backup.
 */
export async function markReady(
  env: Env,
  a: AssetRow,
  now: string,
  r: { exif: ExtractedExif; thumbhash: string; width: number | null; height: number | null; durationMs?: number | null },
): Promise<void> {
  // City, state, country and the GPS time zone (phase 4); videos carry a true UTC instant, photos a wall clock.
  const exif = await enrichGeo(env, a.id, r.exif, { dateIsInstant: r.durationMs !== undefined });
  await commit(env.DB, [
    exifStatement(a, exif),
    tracked(
      `UPDATE assets SET status = 'ready', error = NULL, has_thumbnail = 1, thumbhash = ?2, width = ?3, height = ?4,
         duration = CASE WHEN ?8 THEN ?7 ELSE duration END,
         local_date_time = CASE WHEN EXISTS (SELECT 1 FROM asset_exif WHERE asset_id = ?1 AND instr(COALESCE(locked_properties, ''), '"dateTimeOriginal"') > 0)
           THEN local_date_time ELSE ?5 END,
         updated_at = ?6, update_id = :cursor WHERE id = ?1`,
      a.id,
      r.thumbhash,
      r.width,
      r.height,
      localDateTime(exif.dateTimeOriginal, exif.timeZone, a.file_created_at),
      now,
      r.durationMs ?? null,
      r.durationMs === undefined ? 0 : 1, // photos leave duration alone; videos set it, null when unknown
    ),
  ]);
  await emitUploadReady(env, a.id); // stream H
  await enqueueBackup(env, a.id);
  await enqueueMl(env, a.id); // phase 4: embedding and faces from the new preview
}

/** Images binding input errors (94xx) are terminal; everything else is retried. */
export const isImagesInputError = (err: unknown) => /\b94\d\d\b/.test(String(err));

export async function handleProcessBatch(
  batch: MessageBatch<ProcessMessage>,
  env: Env,
  thumbnailer?: Thumbnailer,
  processor?: MediaProcessor,
): Promise<void> {
  const t = thumbnailer ?? imagesThumbnailer(env.IMAGES);
  const p = processor ?? containerProcessor(env);
  for (const msg of batch.messages) {
    try {
      await processAsset(env, msg.body.assetId, t, msg.body.force === true, p);
      msg.ack();
    } catch (err) {
      console.error('process failed', msg.body.assetId, err);
      if (msg.attempts > PROCESS_MAX_RETRIES) {
        // Last delivery: mark the asset failed here instead of relying on a dead-letter queue, whose name a renamed
        // deployment (the Deploy to Cloudflare form) does not carry over.
        try {
          await markRetriesExhausted(env, msg.body.assetId);
          msg.ack();
        } catch (markErr) {
          console.error('marking failed asset failed', msg.body.assetId, markErr);
          msg.retry();
        }
      } else msg.retry();
    }
  }
}

/** The `max_retries` of the asset-process consumer in wrangler.jsonc: a message is delivered up to this many + 1 times. */
export const PROCESS_MAX_RETRIES = 5;

async function markRetriesExhausted(env: Env, assetId: string): Promise<void> {
  await commit(env.DB, [
    tracked(
      `UPDATE assets SET status = 'failed', error = 'processing retries exhausted', updated_at = ?2, update_id = :cursor WHERE id = ?1 AND status = 'pending'`,
      assetId,
      new Date().toISOString(),
    ),
  ]);
}

/** Deployments created before the dead-letter queue was dropped may still deliver to asset-process-dlq. */
export async function handleProcessDeadLetters(batch: MessageBatch<ProcessMessage>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    try {
      await markRetriesExhausted(env, msg.body.assetId);
      msg.ack();
    } catch (err) {
      console.error('dead-letter handling failed', msg.body.assetId, err);
      msg.retry();
    }
  }
}
