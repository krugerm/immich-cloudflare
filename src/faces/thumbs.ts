// Phase 4 Task D: person thumbnails. Immich crops the original (media.service.ts:391-487); we crop the asset's
// preview with the Images binding so the work stays in the Worker (faces report 5.3 step 4, decision 5.5.3).
import { commit, tracked } from '../db/changes';
import { thumbKey } from '../process/thumbs';
import { emit } from '../realtime/emit';
import type { Box } from './store';

/** Immich FACE_THUMBNAIL_SIZE (server/src/constants.ts:65). */
export const FACE_THUMBNAIL_SIZE = 250;

export function personThumbKey(personGroupId: string): string {
  return `people/${personGroupId}.jpeg`;
}

export interface Size {
  width: number;
  height: number;
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/**
 * Immich `getCrop`: clamp the box to the size it was detected on, scale it to the decoded image, and cut a square
 * around its centre whose half-size is the larger half-side plus 10%, shrunk so it stays inside the image.
 */
export function faceCrop(dims: { old: Size; new: Size }, box: Box): CropRect {
  const x1 = clamp(box.x1, 0, dims.old.width);
  const y1 = clamp(box.y1, 0, dims.old.height);
  const x2 = clamp(box.x2, 0, dims.old.width);
  const y2 = clamp(box.y2, 0, dims.old.height);
  const widthScale = dims.new.width / dims.old.width;
  const heightScale = dims.new.height / dims.old.height;
  const halfWidth = (widthScale * (x2 - x1)) / 2;
  const halfHeight = (heightScale * (y2 - y1)) / 2;
  const middleX = Math.round(widthScale * x1 + halfWidth);
  const middleY = Math.round(heightScale * y1 + halfHeight);
  const targetHalfSize = Math.floor(Math.max(halfWidth, halfHeight) * 1.1);
  const half = Math.min(
    middleX - Math.max(0, middleX - targetHalfSize),
    middleY - Math.max(0, middleY - targetHalfSize),
    Math.min(dims.new.width - 1, middleX + targetHalfSize) - middleX,
    Math.min(dims.new.height - 1, middleY + targetHalfSize) - middleY,
  );
  return { x: middleX - half, y: middleY - half, width: half * 2, height: half * 2 };
}

export interface FaceCropper {
  info(input: Uint8Array): Promise<Size>;
  /** Crops `rect` and scales it down to at most `size` px square, JPEG. */
  crop(input: Uint8Array, rect: CropRect, size: number): Promise<Uint8Array>;
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}

export function imagesCropper(images: ImagesBinding): FaceCropper {
  return {
    async info(input) {
      const i = (await images.info(streamOf(input))) as { width?: number; height?: number };
      if (!i.width || !i.height) throw new Error('ERROR 9412: no image dimensions');
      return { width: i.width, height: i.height };
    },
    async crop(input, rect, size) {
      const result = await images
        .input(streamOf(input))
        .transform({ trim: { left: rect.x, top: rect.y, width: rect.width, height: rect.height } })
        .transform({ width: size, height: size, fit: 'scale-down' }) // Immich: withoutEnlargement
        .output({ format: 'image/jpeg', quality: 80 });
      return new Uint8Array(await result.response().arrayBuffer());
    },
  };
}

interface ThumbSource extends Box {
  asset_id: string;
  image_width: number;
  image_height: number;
}

/**
 * Renders the thumbnail of a person group from its feature face (`people.face_id`) and stores it at
 * `people/<personGroupId>.jpeg`. Every person row of the group gets the key and a new update_id, so `updatedAt`
 * (the web's cache key) changes, and its owner gets `on_person_thumbnail`. Returns false when there is nothing to
 * crop (no live feature face, or the asset has no preview).
 */
export async function renderPersonThumbnail(env: Env, personGroupId: string, cropper: FaceCropper = imagesCropper(env.IMAGES)): Promise<boolean> {
  const face = await env.DB.prepare(
    `SELECT f.asset_id, f.image_width, f.image_height, f.x1, f.y1, f.x2, f.y2
     FROM people p JOIN asset_faces f ON f.id = p.face_id
     WHERE p.person_group_id = ?1 AND f.deleted_at IS NULL
     ORDER BY p.created_at LIMIT 1`,
  ).bind(personGroupId).first<ThumbSource>();
  if (!face) return false;
  const preview = await env.MEDIA.get(thumbKey(face.asset_id, 'preview'));
  if (!preview) return false;
  const bytes = new Uint8Array(await preview.arrayBuffer());
  const size = await cropper.info(bytes);
  const rect = faceCrop({ old: { width: face.image_width, height: face.image_height }, new: size }, face);
  if (rect.width <= 0 || rect.height <= 0) return false;
  const jpeg = await cropper.crop(bytes, rect, FACE_THUMBNAIL_SIZE);
  const key = personThumbKey(personGroupId);
  await env.MEDIA.put(key, jpeg, { httpMetadata: { contentType: 'image/jpeg' } });

  const { results: owners } = await env.DB.prepare('SELECT owner_id FROM people WHERE person_group_id = ?1')
    .bind(personGroupId)
    .all<{ owner_id: string }>();
  const now = new Date().toISOString();
  await commit(
    env.DB,
    owners.map((o) =>
      tracked(
        'UPDATE people SET thumbnail_key = ?3, updated_at = ?4, update_id = :cursor WHERE owner_id = ?1 AND person_group_id = ?2',
        o.owner_id, personGroupId, key, now,
      ),
    ),
  );
  for (const o of owners) await emit(env, o.owner_id, 'on_person_thumbnail', personGroupId);
  return true;
}
