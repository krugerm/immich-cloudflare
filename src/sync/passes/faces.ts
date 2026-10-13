// Phase 4 Task D: PeopleV1 and AssetFacesV3 sync types (faces report section 4; Immich sync.service.ts:915-962,
// sync.repository.ts:424-513). The 3.3 mobile app requests exactly these two.
import type { Dto } from '../../gen/dto';
import type { Pass } from '../passes';

function rows<T>(db: D1Database, sql: string, ...binds: unknown[]) {
  return db.prepare(sql).bind(...binds).all<T>().then((r) => r.results);
}

export interface PersonRow {
  owner_id: string;
  person_group_id: string;
  name: string;
  birth_date: string | null;
  is_hidden: number;
  is_favorite: number;
  color: string | null;
  face_id: string | null;
  thumbnail_key: string;
  created_at: string;
  updated_at: string;
  update_id: string;
}

interface SyncFaceRow {
  id: string;
  asset_id: string;
  person_group_id: string | null;
  image_width: number;
  image_height: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  source_type: string;
  deleted_at: string | null;
  is_visible: number;
  update_id: string;
}

/** Immich serialises a person's birth date (a date column) as midnight UTC. */
function birthDateTime(d: string | null): string | null {
  if (d === null) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00.000Z` : d;
}

export function mapSyncPerson(p: PersonRow): Dto<'SyncPersonV1'> {
  return {
    id: p.person_group_id,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    ownerId: p.owner_id,
    name: p.name,
    birthDate: birthDateTime(p.birth_date),
    isHidden: p.is_hidden === 1,
    isFavorite: p.is_favorite === 1,
    color: p.color,
    faceAssetId: p.face_id,
  };
}

export function mapSyncAssetFace(f: SyncFaceRow): Dto<'SyncAssetFaceV3'> {
  return {
    id: f.id,
    assetId: f.asset_id,
    personId: f.person_group_id,
    imageWidth: f.image_width,
    imageHeight: f.image_height,
    boundingBoxX1: f.x1,
    boundingBoxY1: f.y1,
    boundingBoxX2: f.x2,
    boundingBoxY2: f.y2,
    sourceType: f.source_type,
    deletedAt: f.deleted_at,
    isVisible: f.is_visible === 1,
  };
}

const personDeletes: Pass = {
  entity: 'PersonDeleteV1',
  async fetch(db, userId, after, now, limit) {
    const r = await rows<{ id: string; person_group_id: string }>(
      db, 'SELECT id, person_group_id FROM person_audit WHERE owner_id = ?1 AND id > ?2 AND id <= ?3 ORDER BY id LIMIT ?4', userId, after, now, limit,
    );
    return r.map((d) => ({ cursor: d.id, data: { personId: d.person_group_id } }));
  },
};

const people: Pass = {
  entity: 'PersonV1',
  async fetch(db, userId, after, now, limit) {
    const r = await rows<PersonRow>(db, 'SELECT * FROM people WHERE owner_id = ?1 AND update_id > ?2 AND update_id <= ?3 ORDER BY update_id LIMIT ?4', userId, after, now, limit);
    return r.map((p) => ({ cursor: p.update_id, data: mapSyncPerson(p) }));
  },
};

// AssetFacesV3 is scoped to the caller's cluster group, which is the caller's own user id while there is one group
// per user. Hard deletes come from asset_face_audit rows, which carry the cluster group: storeFaces writes one for each
// machine-learning face it removes. Faces removed by the asset cascade on purge get a delete line only if the purge
// writes their audit rows; soft deletes (deleted_at) are sent as AssetFaceV3 upserts.
const assetFaceDeletes: Pass = {
  entity: 'AssetFaceDeleteV1',
  async fetch(db, userId, after, now, limit) {
    const r = await rows<{ id: string; face_id: string }>(
      db, 'SELECT id, face_id FROM asset_face_audit WHERE cluster_group_id = ?1 AND id > ?2 AND id <= ?3 ORDER BY id LIMIT ?4', userId, after, now, limit,
    );
    return r.map((d) => ({ cursor: d.id, data: { assetFaceId: d.face_id } }));
  },
};

const assetFaces: Pass = {
  entity: 'AssetFaceV3',
  async fetch(db, userId, after, now, limit) {
    const r = await rows<SyncFaceRow>(
      db,
      `SELECT id, asset_id, person_group_id, image_width, image_height, x1, y1, x2, y2, source_type, deleted_at, is_visible, update_id
       FROM asset_faces WHERE cluster_group_id = ?1 AND update_id > ?2 AND update_id <= ?3 ORDER BY update_id LIMIT ?4`,
      userId, after, now, limit,
    );
    return r.map((f) => ({ cursor: f.update_id, data: mapSyncAssetFace(f) }));
  },
};

export const FACE_PASSES: Record<string, Pass[]> = {
  PeopleV1: [personDeletes, people],
  AssetFacesV3: [assetFaceDeletes, assetFaces],
};
