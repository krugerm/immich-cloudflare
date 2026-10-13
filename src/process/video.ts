import { derivedKey, MediaInputError, type MediaProcessor } from '../container/contract';
import type { AssetRow } from '../db/rows';
import { isImagesInputError, markFailed, markReady, renderThumbnails } from './consumer';
import { parseFfprobe } from './ffprobe';
import type { Thumbnailer } from './thumbs';

/** Probes the video and renders its poster in the media container, then writes thumbnails, EXIF and duration. */
export async function processVideo(env: Env, a: AssetRow, thumbnailer: Thumbnailer, processor: MediaProcessor, now: string): Promise<void> {
  const posterKey = derivedKey(a.id, 'poster');
  // A missing original would look like an origin error to the container and be retried forever.
  if (!(await env.MEDIA.head(a.original_path))) return markFailed(env, a, 'original missing', now);
  let result;
  try {
    result = await processor.video(a.original_path, posterKey);
  } catch (err) {
    if (err instanceof MediaInputError) return markFailed(env, a, err.message, now);
    throw err;
  }
  const parsed = parseFfprobe(result.ffprobe);

  const poster = await env.MEDIA.get(posterKey);
  if (!poster) throw new Error(`poster missing at ${posterKey}`);
  const posterBytes = new Uint8Array(await poster.arrayBuffer());

  let thumb;
  try {
    thumb = await renderThumbnails(env, a.id, posterBytes, thumbnailer, null);
  } catch (err) {
    if (!isImagesInputError(err)) throw err;
    return markFailed(env, a, String(err), now, parsed.exif);
  }

  await markReady(env, a, now, {
    exif: parsed.exif,
    thumbhash: thumb.thumbhash,
    width: parsed.width ?? thumb.width,
    height: parsed.height ?? thumb.height,
    durationMs: parsed.durationMs,
  });
}
