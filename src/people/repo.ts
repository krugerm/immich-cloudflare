// Phase 4 E: people and faces storage shared by the people API and the ClusterHub. Every change to a synced row
// (`people`, `asset_faces`) is one tracked statement; group deletes unassign their faces explicitly first.
import { commit, tracked, type Tracked } from '../db/changes';
import { ImmichError } from '../http/errors';
import { fromBlob } from '../ml/contract';
import { vectorStore } from '../ml/vectors';
import { personThumbnailKey, requestPersonThumbnail } from './thumbnail';

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

export interface FaceRow {
  id: string;
  asset_id: string;
  owner_id: string;
  cluster_group_id: string;
  person_group_id: string | null;
  image_width: number;
  image_height: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  score: number | null;
  source_type: 'machine-learning' | 'exif' | 'manual';
  is_visible: number;
  deleted_at: string | null;
  updated_at: string;
  update_id: string;
}

const CHUNK = 50;

/** Immich mapPerson without sharing (one cluster group per user, no person_user rows). */
export function mapPerson(p: PersonRow) {
  return {
    id: p.person_group_id,
    name: p.name,
    birthDate: p.birth_date,
    thumbnailPath: p.thumbnail_key,
    isHidden: p.is_hidden === 1,
    isFavorite: p.is_favorite === 1,
    ...(p.color ? { color: p.color } : {}),
    updatedAt: p.updated_at,
    otherPeople: [],
    sharedBy: [],
    sharedWith: [],
  };
}

export function mapFace(f: FaceRow, person: PersonRow | null) {
  return {
    id: f.id,
    imageWidth: f.image_width,
    imageHeight: f.image_height,
    boundingBoxX1: f.x1,
    boundingBoxY1: f.y1,
    boundingBoxX2: f.x2,
    boundingBoxY2: f.y2,
    sourceType: f.source_type,
    person: person ? mapPerson(person) : null,
  };
}

export async function getPerson(db: D1Database, ownerId: string, personGroupId: string): Promise<PersonRow | null> {
  return db.prepare('SELECT * FROM people WHERE owner_id = ?1 AND person_group_id = ?2').bind(ownerId, personGroupId).first<PersonRow>();
}

/**
 * Immich requirePersonAccess without sharing: each `(owner, group)` pair must be the caller's own person row.
 * `permission` names the Immich permission in the error.
 */
export async function requirePersonAccess(db: D1Database, userId: string, ids: Array<{ personGroupId: string; ownerId: string }>, permission: string): Promise<void> {
  const unique = [...new Set(ids.map((i) => `${i.ownerId}/${i.personGroupId}`))];
  if (ids.some((i) => i.ownerId !== userId)) throw new ImmichError(400, `Not found or no ${permission} access`);
  const groups = unique.map((k) => k.split('/')[1]);
  const row = await db
    .prepare('SELECT count(*) AS n FROM people WHERE owner_id = ?1 AND person_group_id IN (SELECT value FROM json_each(?2))')
    .bind(userId, JSON.stringify(groups))
    .first<{ n: number }>();
  if ((row?.n ?? 0) !== groups.length) throw new ImmichError(400, `Not found or no ${permission} access`);
}

/** Immich checkFaceOwnerAccess: the face ids whose asset the caller owns and has not trashed. */
export async function ownedFaceIds(db: D1Database, userId: string, faceIds: string[]): Promise<Set<string>> {
  if (faceIds.length === 0) return new Set();
  const { results } = await db
    .prepare(
      `SELECT f.id FROM asset_faces f JOIN assets a ON a.id = f.asset_id AND a.deleted_at IS NULL
       WHERE f.id IN (SELECT value FROM json_each(?1)) AND a.owner_id = ?2`,
    )
    .bind(JSON.stringify(faceIds), userId)
    .all<{ id: string }>();
  return new Set(results.map((r) => r.id));
}

export function insertGroup(db: D1Database, id: string, clusterGroupId: string, now: string): D1PreparedStatement {
  return db.prepare('INSERT INTO person_groups (id, cluster_group_id, created_at) VALUES (?1, ?2, ?3)').bind(id, clusterGroupId, now);
}

export function insertPerson(
  p: { ownerId: string; personGroupId: string; name?: string; birthDate?: string | null; isHidden?: boolean; isFavorite?: boolean; color?: string | null; faceId?: string | null },
  now: string,
  opts: { ifMissing?: boolean } = {},
): Tracked {
  return tracked(
    `INSERT INTO people (owner_id, person_group_id, name, birth_date, is_hidden, is_favorite, color, face_id, thumbnail_key, created_at, updated_at, update_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, '', ?9, ?9, :cursor)${opts.ifMissing ? ' ON CONFLICT (owner_id, person_group_id) DO NOTHING' : ''}`,
    p.ownerId,
    p.personGroupId,
    p.name ?? '',
    p.birthDate ?? null,
    p.isHidden ? 1 : 0,
    p.isFavorite ? 1 : 0,
    p.color ?? null,
    p.faceId ?? null,
    now,
  );
}

/** One face moved to `personGroupId` (null unassigns). `onlyIfUnassigned` is the clusterer's guard against a concurrent manual move. */
export function assignFace(faceId: string, personGroupId: string | null, now: string, opts: { onlyIfUnassigned?: boolean } = {}): Tracked {
  return tracked(
    `UPDATE asset_faces SET person_group_id = ?1, updated_at = ?2, update_id = :cursor WHERE id = ?3${opts.onlyIfUnassigned ? ' AND person_group_id IS NULL' : ''}`,
    personGroupId,
    now,
    faceId,
  );
}

/** Test seam: called before each sync, so a test can make the Vectorize write fail. */
export const vectorSyncTestHooks: { beforeSync?: (faceIds: string[]) => void } = {};

/**
 * Mirrors each face's assignment into its vector: metadata `{ assigned: '1' }` while it has a person, none otherwise
 * (an upsert replaces the metadata). Faces without an embedding (manual) and soft-deleted faces are left alone.
 * Deploy: the face index needs a string metadata index on `assigned`.
 */
export async function syncFaceVectors(env: Env, faceIds: string[]): Promise<void> {
  const store = vectorStore(env, 'face');
  if (!store || faceIds.length === 0) return;
  vectorSyncTestHooks.beforeSync?.(faceIds);
  for (let i = 0; i < faceIds.length; i += 200) {
    const { results } = await env.DB.prepare(
      `SELECT f.id, f.cluster_group_id, f.person_group_id, e.embedding FROM asset_faces f JOIN face_embeddings e ON e.face_id = f.id
       WHERE f.id IN (SELECT value FROM json_each(?1)) AND f.deleted_at IS NULL`,
    )
      .bind(JSON.stringify(faceIds.slice(i, i + 200)))
      .all<{ id: string; cluster_group_id: string; person_group_id: string | null; embedding: ArrayBuffer | number[] }>();
    if (results.length === 0) continue;
    await store.upsert(
      results.map((r) => ({
        id: r.id,
        values: fromBlob(new Uint8Array(r.embedding)),
        namespace: r.cluster_group_id,
        ...(r.person_group_id ? { metadata: { assigned: '1' } } : {}),
      })),
    );
  }
}

export async function commitChunked(db: D1Database, items: Array<Tracked | D1PreparedStatement>): Promise<void> {
  for (let i = 0; i < items.length; i += CHUNK) await commit(db, items.slice(i, i + CHUNK));
}

/** Updates a person row; `fields` maps column to value. Bumps updated_at and update_id. */
export function updatePersonRow(ownerId: string, personGroupId: string, fields: Record<string, unknown>, now: string): Tracked {
  const cols = Object.keys(fields);
  const sets = cols.map((c, i) => `${c} = ?${i + 4}`).join(', ');
  return tracked(
    `UPDATE people SET ${sets}${sets ? ', ' : ''}updated_at = ?3, update_id = :cursor WHERE owner_id = ?1 AND person_group_id = ?2`,
    ownerId,
    personGroupId,
    now,
    ...cols.map((c) => fields[c]),
  );
}

/**
 * Immich createNewFeaturePhoto: each person gets the first visible, non-deleted face of its group as feature face and
 * a new thumbnail. People whose group has no face keep theirs.
 */
export async function createNewFeaturePhoto(env: Env, people: Array<{ ownerId: string; personGroupId: string }>): Promise<void> {
  const now = new Date().toISOString();
  for (const { ownerId, personGroupId } of people) {
    const face = await env.DB.prepare(
      'SELECT id FROM asset_faces WHERE person_group_id = ?1 AND deleted_at IS NULL AND is_visible = 1 ORDER BY id LIMIT 1',
    )
      .bind(personGroupId)
      .first<{ id: string }>();
    if (!face) continue;
    await commit(env.DB, [updatePersonRow(ownerId, personGroupId, { face_id: face.id }, now)]);
    await requestPersonThumbnail(env, personGroupId);
  }
}

/** Deletes person rows (audit first) and their thumbnails. Returns the deleted rows. */
export async function deletePeople(env: Env, ownerId: string, personGroupIds: string[]): Promise<PersonRow[]> {
  if (personGroupIds.length === 0) return [];
  const { results } = await env.DB.prepare('SELECT * FROM people WHERE owner_id = ?1 AND person_group_id IN (SELECT value FROM json_each(?2))')
    .bind(ownerId, JSON.stringify(personGroupIds))
    .all<PersonRow>();
  const now = new Date().toISOString();
  const items: Array<Tracked | D1PreparedStatement> = [];
  for (const p of results) {
    items.push(
      tracked('INSERT INTO person_audit (id, person_group_id, owner_id, deleted_at) VALUES (:cursor, ?1, ?2, ?3)', p.person_group_id, p.owner_id, now),
      env.DB.prepare('DELETE FROM people WHERE owner_id = ?1 AND person_group_id = ?2').bind(p.owner_id, p.person_group_id),
    );
  }
  await commitChunked(env.DB, items);
  const keys = [...new Set(results.flatMap((p) => [p.thumbnail_key, personThumbnailKey(p.person_group_id)]).filter(Boolean))];
  if (keys.length > 0) await env.MEDIA.delete(keys);
  return results;
}

/**
 * Immich deleteEmptyGroups, limited to `groupIds`: a group with no person row is deleted after its faces are
 * unassigned one tracked statement each (Immich relies on ON DELETE SET NULL, which would skip the sync cursor).
 */
export async function deleteEmptyGroups(env: Env, groupIds: string[]): Promise<void> {
  if (groupIds.length === 0) return;
  const { results: empty } = await env.DB.prepare(
    `SELECT g.id FROM person_groups g WHERE g.id IN (SELECT value FROM json_each(?1))
     AND NOT EXISTS (SELECT 1 FROM people p WHERE p.person_group_id = g.id)`,
  )
    .bind(JSON.stringify(groupIds))
    .all<{ id: string }>();
  if (empty.length === 0) return;
  const ids = JSON.stringify(empty.map((g) => g.id));
  const { results: faces } = await env.DB.prepare('SELECT id FROM asset_faces WHERE person_group_id IN (SELECT value FROM json_each(?1))')
    .bind(ids)
    .all<{ id: string }>();
  const now = new Date().toISOString();
  await commitChunked(env.DB, faces.map((f) => assignFace(f.id, null, now)));
  await syncFaceVectors(env, faces.map((f) => f.id));
  await env.DB.prepare('DELETE FROM person_groups WHERE id IN (SELECT value FROM json_each(?1))').bind(ids).run();
}

/**
 * Immich handlePersonCleanup for one cluster group: people whose group has no visible, non-deleted face are deleted,
 * then the groups left without people.
 */
export async function personCleanup(env: Env, clusterGroupId: string): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT p.owner_id, p.person_group_id FROM people p JOIN person_groups g ON g.id = p.person_group_id
     WHERE g.cluster_group_id = ?1 AND NOT EXISTS (
       SELECT 1 FROM asset_faces f WHERE f.person_group_id = p.person_group_id AND f.deleted_at IS NULL AND f.is_visible = 1)`,
  )
    .bind(clusterGroupId)
    .all<{ owner_id: string; person_group_id: string }>();
  const byOwner = new Map<string, string[]>();
  for (const r of results) byOwner.set(r.owner_id, [...(byOwner.get(r.owner_id) ?? []), r.person_group_id]);
  for (const [owner, ids] of byOwner) await deletePeople(env, owner, ids);
  await refreshStaleFeatureFaces(env, clusterGroupId);
  const { results: groups } = await env.DB.prepare('SELECT id FROM person_groups WHERE cluster_group_id = ?1').bind(clusterGroupId).all<{ id: string }>();
  await deleteEmptyGroups(env, groups.map((g) => g.id));
}

/**
 * People of the cluster group whose feature face is missing, soft-deleted, invisible or no longer in their group (a
 * re-detection soft-deletes vanished faces) get a new one from their remaining faces.
 */
export async function refreshStaleFeatureFaces(env: Env, clusterGroupId: string): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT p.owner_id, p.person_group_id FROM people p JOIN person_groups g ON g.id = p.person_group_id
     WHERE g.cluster_group_id = ?1 AND NOT EXISTS (
       SELECT 1 FROM asset_faces f WHERE f.id = p.face_id AND f.person_group_id = p.person_group_id AND f.deleted_at IS NULL AND f.is_visible = 1)`,
  )
    .bind(clusterGroupId)
    .all<{ owner_id: string; person_group_id: string }>();
  await createNewFeaturePhoto(env, results.map((r) => ({ ownerId: r.owner_id, personGroupId: r.person_group_id })));
}

/** Prefix and word-start patterns for a case-insensitive name match (approximates Immich's trigram word similarity). */
export function namePatterns(name: string): [string, string] {
  const term = name.trim().toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`);
  return [`${term}%`, `% ${term}%`];
}

export const NAME_MATCH = (col: string, prefix: string, word: string) =>
  `(lower(${col}) LIKE ${prefix} ESCAPE '\\' OR lower(${col}) LIKE ${word} ESCAPE '\\')`;
