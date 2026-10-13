// Phase 4 Task D: reconcile detected faces with the asset's stored faces (Immich `handleDetectFaces`,
// server/src/services/person.service.ts:395-477), store embeddings in D1 and Vectorize, and hand new faces to the
// cluster group's ClusterHub.
import { commit, tracked, type Tracked } from '../db/changes';
import type { AssetRow } from '../db/rows';
import { fromBlob, toBlob, type MlImageResult } from '../ml/contract';
import { vectorStore, type VectorKind } from '../ml/vectors';

export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
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

/** Intersection over union, as Immich computes it (person.service.ts:479-494). */
export function iou(a: Box, b: Box): number {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - intersection;
  return union > 0 ? intersection / union : 0;
}

/** One cluster group per user for now: the group id is the owner's user id. */
export function clusterGroupOf(a: Pick<AssetRow, 'owner_id'>): string {
  return a.owner_id;
}

export interface FaceChanges {
  /** New machine-learning faces: index into the detected list plus the new face id. */
  added: Array<{ index: number; id: string }>;
  /** Existing manual or EXIF faces that a detected face overlaps: they receive its embedding. */
  embedded: Array<{ index: number; id: string }>;
  /** Machine-learning faces (soft-deleted ones included) that no detected face overlaps: hard-deleted. */
  removed: string[];
}

/**
 * Immich's reconciliation (person.service.ts:395-477). Each detected box is scaled into the pixel space of every stored
 * face (stored faces carry the image size their box refers to) and matched to the first stored face with IoU above
 * 0.5. Soft-deleted faces take part, so a face the user deleted is matched and not re-created. A match on a
 * machine-learning face keeps that face unchanged; a match on a manual or EXIF face gives it the embedding; no match
 * creates a face. Every machine-learning face left unmatched (soft-deleted or not) is removed.
 */
export function reconcileFaces(existing: FaceRow[], detected: MlImageResult, newId: () => string = () => crypto.randomUUID()): FaceChanges {
  const ml = existing.filter((f) => f.source_type === 'machine-learning').map((f) => f.id);
  const kept = new Set<string>();
  const changes: FaceChanges = { added: [], embedded: [], removed: [] };
  (detected.faces ?? []).forEach((face, index) => {
    const match = existing.find((f) => {
      const sx = f.image_width / (detected.imageWidth || 1);
      const sy = f.image_height / (detected.imageHeight || 1);
      const b = face.boundingBox;
      return iou(f, { x1: b.x1 * sx, y1: b.y1 * sy, x2: b.x2 * sx, y2: b.y2 * sy }) > 0.5;
    });
    if (!match) changes.added.push({ index, id: newId() });
    else if (match.source_type === 'machine-learning') kept.add(match.id);
    else changes.embedded.push({ index, id: match.id });
  });
  changes.removed = ml.filter((id) => !kept.has(id));
  return changes;
}

/**
 * Stores the faces of one ML result for an asset, in this order:
 * 1. one D1 commit: new faces and embeddings, embeddings for overlapped manual/EXIF faces, and for each
 *    machine-learning face no longer detected an `asset_face_audit` row, a `vector_delete_queue` row and a hard delete
 *    (as Immich; the embedding goes with it by cascade). Manual and EXIF faces are never removed.
 * 2. vectors: every live face of the asset that has an embedding is upserted from D1 (idempotent, so a run after a
 *    failed upsert restores what the previous run missed), then the queued vectors of removed faces are deleted and
 *    their queue rows removed (a failure leaves the rows for the next drain).
 * 3. the ClusterHub gets every unassigned live machine-learning face of the asset; a failure throws so the queue
 *    retries the job, and the retry re-sends the same faces.
 * Returns the ids of the new faces.
 */
export async function storeFaces(env: Env, a: AssetRow, result: MlImageResult): Promise<string[]> {
  if (!result.faces || a.visibility === 'hidden') return []; // Immich skips the video half of a live photo
  const clusterGroupId = clusterGroupOf(a);
  const { results: existing } = await env.DB.prepare('SELECT * FROM asset_faces WHERE asset_id = ?1 ORDER BY rowid')
    .bind(a.id)
    .all<FaceRow>();
  const byId = new Map(existing.map((f) => [f.id, f]));
  const changes = reconcileFaces(existing, result);
  const now = new Date().toISOString();
  const faces = result.faces;

  const items: Array<Tracked | D1PreparedStatement> = [];
  for (const { index, id } of changes.added) {
    const { boundingBox: b, score } = faces[index];
    items.push(
      tracked(
        `INSERT INTO asset_faces (id, asset_id, owner_id, cluster_group_id, person_group_id, image_width, image_height,
           x1, y1, x2, y2, score, source_type, is_visible, deleted_at, updated_at, update_id)
         VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'machine-learning', 1, NULL, ?12, :cursor)`,
        id, a.id, a.owner_id, clusterGroupId, result.imageWidth, result.imageHeight,
        Math.round(b.x1), Math.round(b.y1), Math.round(b.x2), Math.round(b.y2), score, now,
      ),
    );
  }
  for (const { index, id } of [...changes.added, ...changes.embedded]) {
    items.push(
      env.DB.prepare('INSERT INTO face_embeddings (face_id, embedding) VALUES (?1, ?2) ON CONFLICT (face_id) DO UPDATE SET embedding = excluded.embedding')
        .bind(id, toBlob(faces[index].embedding)),
    );
  }
  // Audit and vector-queue rows are written only while the face still exists, so a run racing another one (a retry,
  // or a purge) that already removed it writes neither a second AssetFaceDeleteV1 nor a stray queue row.
  const stillThere = "EXISTS (SELECT 1 FROM asset_faces WHERE id = ?1 AND source_type = 'machine-learning')";
  for (const id of changes.removed) {
    const f = byId.get(id)!;
    items.push(
      tracked(
        `INSERT INTO asset_face_audit (id, face_id, asset_id, owner_id, cluster_group_id, deleted_at)
         SELECT :cursor, ?1, ?2, ?3, ?4, ?5 WHERE ${stillThere}`,
        f.id, f.asset_id, f.owner_id, f.cluster_group_id, now,
      ),
    );
    items.push(
      env.DB.prepare(`INSERT OR IGNORE INTO vector_delete_queue (index_name, vector_id, queued_at) SELECT 'face', ?1, ?2 WHERE ${stillThere}`)
        .bind(id, now),
    );
    items.push(env.DB.prepare("DELETE FROM asset_faces WHERE id = ?1 AND source_type = 'machine-learning'").bind(id));
  }
  // faces_recognized_at is not part of any sync payload: a plain statement, no update_id bump
  items.push(env.DB.prepare('UPDATE assets SET faces_recognized_at = ?2 WHERE id = ?1').bind(a.id, now));
  await commit(env.DB, items);

  const store = vectorStore(env, 'face');
  if (store) {
    const { results: vectors } = await env.DB.prepare(
      `SELECT f.id, f.cluster_group_id, f.person_group_id, e.embedding FROM asset_faces f JOIN face_embeddings e ON e.face_id = f.id
       WHERE f.asset_id = ?1 AND f.deleted_at IS NULL`,
    ).bind(a.id).all<{ id: string; cluster_group_id: string; person_group_id: string | null; embedding: ArrayBuffer }>();
    if (vectors.length > 0) {
      // Keep the `assigned` flag the clusterer filters on (src/faces/cluster.ts): a re-upsert replaces metadata.
      await store.upsert(
        vectors.map((v) => ({
          id: v.id,
          values: fromBlob(v.embedding),
          namespace: v.cluster_group_id,
          ...(v.person_group_id ? { metadata: { assigned: '1' } } : {}),
        })),
      );
    }
  }
  if (changes.removed.length > 0) await drainVectorDeletes(env, 'face', changes.removed);

  const { results: unassigned } = await env.DB.prepare(
    `SELECT id FROM asset_faces WHERE asset_id = ?1 AND source_type = 'machine-learning' AND person_group_id IS NULL
     AND deleted_at IS NULL ORDER BY rowid`,
  ).bind(a.id).all<{ id: string }>();
  if (unassigned.length > 0) await notifyClusterHub(env, clusterGroupId, unassigned.map((f) => f.id));
  return changes.added.map((f) => f.id);
}

/**
 * Deletes queued vectors from the index, then their `vector_delete_queue` rows. With `ids`, only those queued ids;
 * without, the oldest 1000 queued for the index. A failure throws and leaves the rows for the next drain (Task G's
 * purge run drains the whole queue with `deleteQueuedVectors`, which can replace this). No-op without a bound index.
 */
export async function drainVectorDeletes(env: Env, kind: VectorKind, ids?: string[]): Promise<void> {
  const store = vectorStore(env, kind);
  if (!store) return;
  const { results } = ids
    ? await env.DB.prepare('SELECT vector_id FROM vector_delete_queue WHERE index_name = ?1 AND vector_id IN (SELECT value FROM json_each(?2))')
      .bind(kind, JSON.stringify(ids)).all<{ vector_id: string }>()
    : await env.DB.prepare('SELECT vector_id FROM vector_delete_queue WHERE index_name = ?1 ORDER BY queued_at LIMIT 1000')
      .bind(kind).all<{ vector_id: string }>();
  const queued = results.map((r) => r.vector_id);
  if (queued.length === 0) return;
  await store.deleteByIds(queued);
  await env.DB.prepare('DELETE FROM vector_delete_queue WHERE index_name = ?1 AND vector_id IN (SELECT value FROM json_each(?2))')
    .bind(kind, JSON.stringify(queued)).run();
}

/** Hands face ids to the cluster group's ClusterHub. Throws on failure, so the ML job is retried. */
export async function notifyClusterHub(env: Env, clusterGroupId: string, faceIds: string[]): Promise<void> {
  const hub = env.CLUSTER_HUB.get(env.CLUSTER_HUB.idFromName(clusterGroupId));
  const res = await hub.fetch('https://cluster-hub/faces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ faceIds }),
  });
  if (!res.ok) throw new Error(`cluster hub rejected faces for ${clusterGroupId}: ${res.status}`);
}
