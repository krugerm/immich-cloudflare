import type { AssetRow, ExifRow, UserRow } from '../db/rows';
import type { Dto } from '../gen/dto';
import type { StackRow } from '../stacks/repo';
import { mapSyncAuthUser, mapSyncUser } from '../users/map';
import { ALBUM_PASSES } from './passes/albums'; // stream C
import { FACE_PASSES } from './passes/faces'; // phase 4 Task D
import { MEMORY_PASSES } from './passes/memories'; // stream F
import { PARTNER_PASSES } from './passes/partners'; // stream D

/** A keyset pass over one entity type: one D1 query per page, each row acked `<entity>|<cursor>`. */
export interface Pass {
  entity: string;
  fetch(db: D1Database, userId: string, after: string, now: string, limit: number): Promise<Array<{ cursor: string; data: unknown }>>;
}

/**
 * Passes that need other checkpoints, write checkpoints, or emit SyncAckV1 / backfill acks (album and partner backfill,
 * album asset creates/updates) yield whole lines through a SyncContext.
 */
export interface SyncContext {
  db: D1Database;
  userId: string;
  sessionId: string;
  now: string;
  pageSize: number;
  /** Checkpoints at stream start, by entity type, with the backfill progress id. */
  acks: Map<string, { updateId: string; extraId?: string }>;
  /** Runs one statement against the stream's query budget; throws BudgetExhausted when it is spent. */
  all<T>(stmt: D1PreparedStatement): Promise<T[]>;
}

export interface StreamPass {
  entity: string;
  /** Yields JSON lines (each ending in '\n'), one chunk per page. */
  stream(ctx: SyncContext): AsyncGenerator<string>;
}

export class BudgetExhausted extends Error {}

export function mapSyncAsset(a: AssetRow): Dto<'SyncAssetV2'> {
  return {
    id: a.id,
    ownerId: a.owner_id,
    originalFileName: a.original_file_name,
    checksum: a.checksum,
    type: a.type,
    visibility: a.visibility,
    isFavorite: a.is_favorite === 1,
    isEdited: false,
    fileCreatedAt: a.file_created_at,
    fileModifiedAt: a.file_modified_at,
    localDateTime: a.local_date_time,
    createdAt: a.created_at,
    deletedAt: a.deleted_at,
    duration: a.duration,
    width: a.width,
    height: a.height,
    thumbhash: a.thumbhash,
    livePhotoVideoId: a.live_photo_video_id,
    stackId: a.stack_id,
    libraryId: null,
  };
}

export function mapSyncExif(e: ExifRow): Dto<'SyncAssetExifV1'> {
  return {
    assetId: e.asset_id,
    make: e.make, model: e.model, lensModel: e.lens_model, exposureTime: e.exposure_time,
    fNumber: e.f_number, focalLength: e.focal_length, iso: e.iso,
    latitude: e.latitude, longitude: e.longitude, city: e.city, state: e.state, country: e.country,
    dateTimeOriginal: e.date_time_original, modifyDate: e.modify_date, timeZone: e.time_zone,
    orientation: e.orientation, rating: e.rating, description: e.description,
    exifImageWidth: e.exif_image_width, exifImageHeight: e.exif_image_height, fileSizeInByte: e.file_size_in_byte,
    profileDescription: e.profile_description, projectionType: e.projection_type, fps: e.fps,
  };
}

export function mapSyncStack(s: StackRow): Dto<'SyncStackV1'> {
  return { id: s.id, createdAt: s.created_at, updatedAt: s.updated_at, primaryAssetId: s.primary_asset_id, ownerId: s.owner_id };
}

function rows<T>(db: D1Database, sql: string, ...binds: unknown[]) {
  return db.prepare(sql).bind(...binds).all<T>().then((r) => r.results);
}

const authUsers: Pass = {
  entity: 'AuthUserV2',
  async fetch(db, userId, after, now, limit) {
    const r = await rows<UserRow>(db, 'SELECT * FROM users WHERE id = ?1 AND update_id > ?2 AND update_id <= ?3 ORDER BY update_id LIMIT ?4', userId, after, now, limit);
    return r.map((u) => ({ cursor: u.update_id, data: mapSyncAuthUser(u) }));
  },
};

const userDeletes: Pass = {
  entity: 'UserDeleteV1',
  async fetch(db, _userId, after, now, limit) {
    const r = await rows<{ id: string; user_id: string }>(db, 'SELECT id, user_id FROM user_audit WHERE id > ?1 AND id <= ?2 ORDER BY id LIMIT ?3', after, now, limit);
    return r.map((d) => ({ cursor: d.id, data: { userId: d.user_id } }));
  },
};

const users: Pass = {
  entity: 'UserV1',
  async fetch(db, _userId, after, now, limit) {
    const r = await rows<UserRow>(db, 'SELECT * FROM users WHERE update_id > ?1 AND update_id <= ?2 ORDER BY update_id LIMIT ?3', after, now, limit);
    return r.map((u) => ({ cursor: u.update_id, data: mapSyncUser(u) }));
  },
};

const assetDeletes: Pass = {
  entity: 'AssetDeleteV1',
  async fetch(db, userId, after, now, limit) {
    const r = await rows<{ id: string; asset_id: string }>(db, 'SELECT id, asset_id FROM asset_audit WHERE owner_id = ?1 AND id > ?2 AND id <= ?3 ORDER BY id LIMIT ?4', userId, after, now, limit);
    return r.map((d) => ({ cursor: d.id, data: { assetId: d.asset_id } }));
  },
};

const assets: Pass = {
  entity: 'AssetV2',
  async fetch(db, userId, after, now, limit) {
    const r = await rows<AssetRow>(db, 'SELECT * FROM assets WHERE owner_id = ?1 AND update_id > ?2 AND update_id <= ?3 ORDER BY update_id LIMIT ?4', userId, after, now, limit);
    return r.map((a) => ({ cursor: a.update_id, data: mapSyncAsset(a) }));
  },
};

const exifs: Pass = {
  entity: 'AssetExifV1',
  async fetch(db, userId, after, now, limit) {
    const r = await rows<ExifRow>(db, 'SELECT * FROM asset_exif WHERE owner_id = ?1 AND update_id > ?2 AND update_id <= ?3 ORDER BY update_id LIMIT ?4', userId, after, now, limit);
    return r.map((e) => ({ cursor: e.update_id, data: mapSyncExif(e) }));
  },
};

// stream B
const assetMetadataDeletes: Pass = {
  entity: 'AssetMetadataDeleteV1',
  async fetch(db, userId, after, now, limit) {
    const r = await rows<{ id: string; asset_id: string; key: string }>(db, 'SELECT id, asset_id, key FROM asset_metadata_audit WHERE owner_id = ?1 AND id > ?2 AND id <= ?3 ORDER BY id LIMIT ?4', userId, after, now, limit);
    return r.map((d) => ({ cursor: d.id, data: { assetId: d.asset_id, key: d.key } }));
  },
};

const assetMetadata: Pass = {
  entity: 'AssetMetadataV1',
  async fetch(db, userId, after, now, limit) {
    const r = await rows<{ asset_id: string; key: string; value: string; update_id: string }>(db, 'SELECT asset_id, key, value, update_id FROM asset_metadata WHERE owner_id = ?1 AND update_id > ?2 AND update_id <= ?3 ORDER BY update_id LIMIT ?4', userId, after, now, limit);
    return r.map((m) => ({ cursor: m.update_id, data: { assetId: m.asset_id, key: m.key, value: JSON.parse(m.value) } }));
  },
};

// stream E
const stackDeletes: Pass = {
  entity: 'StackDeleteV1',
  async fetch(db, userId, after, now, limit) {
    const r = await rows<{ id: string; stack_id: string }>(db, 'SELECT id, stack_id FROM stack_audit WHERE owner_id = ?1 AND id > ?2 AND id <= ?3 ORDER BY id LIMIT ?4', userId, after, now, limit);
    return r.map((d) => ({ cursor: d.id, data: { stackId: d.stack_id } }));
  },
};

const stacks: Pass = {
  entity: 'StackV1',
  async fetch(db, userId, after, now, limit) {
    const r = await rows<StackRow>(db, 'SELECT * FROM stacks WHERE owner_id = ?1 AND update_id > ?2 AND update_id <= ?3 ORDER BY update_id LIMIT ?4', userId, after, now, limit);
    return r.map((s) => ({ cursor: s.update_id, data: mapSyncStack(s) }));
  },
};

/** Request types in Immich's SYNC_TYPES_ORDER; each lists its passes in order. */
export const REQUEST_ORDER = [
  'AuthUsersV2',
  'UsersV1',
  'PartnersV1', // stream D
  'AssetsV2',
  'StacksV1', // stream E
  'PartnerAssetsV2', // stream D
  'PartnerStacksV1', // stream D
  'AlbumAssetsV2', // stream C
  'AlbumsV2', // stream C
  'AlbumUsersV1', // stream C
  'AlbumToAssetsV1', // stream C
  'AssetExifsV1',
  'AlbumAssetExifsV1', // stream C
  'PartnerAssetExifsV1', // stream D
  'MemoriesV2', // stream F
  'MemoryToAssetsV2', // stream F
  'PeopleV1', // phase 4 Task D
  'AssetFacesV3', // phase 4 Task D
  'AssetMetadataV1', // stream B
];
export const PASSES: Record<string, Array<Pass | StreamPass>> = {
  AuthUsersV2: [authUsers],
  UsersV1: [userDeletes, users],
  AssetsV2: [assetDeletes, assets],
  StacksV1: [stackDeletes, stacks], // stream E
  AssetExifsV1: [exifs],
  ...PARTNER_PASSES, // stream D
  ...ALBUM_PASSES, // stream C
  ...MEMORY_PASSES, // stream F
  ...FACE_PASSES, // phase 4 Task D
  AssetMetadataV1: [assetMetadataDeletes, assetMetadata], // stream B
};
