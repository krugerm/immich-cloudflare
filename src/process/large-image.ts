import { derivedKey, MediaInputError, type MediaProcessor } from '../container/contract';
import type { AssetRow } from '../db/rows';
import { isImagesInputError, markFailed, markReady, renderThumbnails } from './consumer';
import { mapExiftool } from './exiftool-map';
import type { Thumbnailer } from './thumbs';

/** RAW files and images over 20 MB: the media container writes an upright JPEG and returns the original's EXIF. */
export async function processLargeImage(env: Env, a: AssetRow, thumbnailer: Thumbnailer, processor: MediaProcessor, now: string): Promise<void> {
  const fullKey = derivedKey(a.id, 'full');
  // A missing original would look like an origin error to the container and be retried forever.
  if (!(await env.MEDIA.head(a.original_path))) return markFailed(env, a, 'original missing', now);
  let result;
  try {
    result = await processor.image(a.original_path, fullKey);
  } catch (err) {
    if (err instanceof MediaInputError) return markFailed(env, a, err.message, now);
    throw err;
  }
  const exif = mapExiftool(result.exiftool);

  const full = await env.MEDIA.get(fullKey);
  if (!full) throw new Error(`container did not write ${fullKey}`);
  const bytes = new Uint8Array(await full.arrayBuffer());

  let thumbhash: string;
  let size: { width: number; height: number };
  try {
    const r = await renderThumbnails(env, a.id, bytes, thumbnailer, null);
    thumbhash = r.thumbhash;
    size = r;
  } catch (err) {
    if (!isImagesInputError(err)) throw err;
    return markFailed(env, a, String(err), now, exif);
  }

  // mapExiftool reports the stored size before orientation; display size swaps for orientations 5 to 8.
  const swap = exif.orientation !== null && Number(exif.orientation) >= 5;
  const width = (swap ? exif.height : exif.width) ?? size.width;
  const height = (swap ? exif.width : exif.height) ?? size.height;

  await markReady(env, a, now, { exif, thumbhash, width, height });
}
