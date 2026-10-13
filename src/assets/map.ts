import type { AssetRow, ExifRow } from '../db/rows';
import type { Dto } from '../gen/dto';
import { contentTypeFor, extensionOf } from '../upload/media-types';

export function mapAssetResponse(a: AssetRow, e: ExifRow | null): Dto<'AssetResponseDto'> {
  return {
    id: a.id,
    ownerId: a.owner_id,
    type: a.type,
    originalFileName: a.original_file_name,
    originalPath: a.original_path,
    originalMimeType: contentTypeFor(extensionOf(a.original_path)),
    checksum: a.checksum,
    fileCreatedAt: a.file_created_at,
    fileModifiedAt: a.file_modified_at,
    localDateTime: a.local_date_time,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
    duration: a.duration,
    width: a.width,
    height: a.height,
    thumbhash: a.thumbhash,
    isFavorite: a.is_favorite === 1,
    isArchived: a.visibility === 'archive',
    isTrashed: a.deleted_at !== null,
    isOffline: false,
    isEdited: false,
    hasMetadata: e !== null,
    visibility: a.visibility,
    livePhotoVideoId: a.live_photo_video_id,
    exifInfo: e
      ? {
          make: e.make, model: e.model, lensModel: e.lens_model, exposureTime: e.exposure_time,
          fNumber: e.f_number, focalLength: e.focal_length, iso: e.iso,
          latitude: e.latitude, longitude: e.longitude, city: e.city, state: e.state, country: e.country,
          dateTimeOriginal: e.date_time_original, modifyDate: e.modify_date, timeZone: e.time_zone,
          orientation: e.orientation, rating: e.rating, description: e.description,
          exifImageWidth: e.exif_image_width, exifImageHeight: e.exif_image_height, fileSizeInByte: e.file_size_in_byte,
          projectionType: e.projection_type,
        }
      : undefined,
  };
}
