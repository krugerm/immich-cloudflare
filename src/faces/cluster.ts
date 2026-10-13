// Phase 4 E: Immich's incremental face clustering (server/src/services/person.service.ts handleRecognizeFaces and
// search.repository.ts searchFaces), run one face at a time by the ClusterHub of the face's cluster group.
import { getSystemConfig } from '../config/store';
import { commit, type Tracked } from '../db/changes';
import { fromBlob } from '../ml/contract';
import { vectorStore, type VectorStore } from '../ml/vectors';
import { assignFace, commitChunked, insertGroup, insertPerson, personCleanup, syncFaceVectors } from '../people/repo';
import { requestPersonThumbnail } from '../people/thumbnail';

export interface ClusterSettings {
  enabled: boolean;
  maxDistance: number;
  minFaces: number;
}

export interface BufferedFace {
  id: string;
  values: number[];
}

export type RecognizeResult = 'assigned' | 'deferred' | 'skipped';

/** How many nearest vectors a core-face search reads before the D1 re-check trims them to `minFaces`. */
const NEIGHBOUR_TOP_K = 20;
/** The hasPerson fallback reads this many vectors flagged `assigned`; D1 then drops stale flags. */
const HAS_PERSON_TOP_K = 20;

export async function clusterSettings(db: D1Database): Promise<ClusterSettings> {
  const ml = (await getSystemConfig(db)).machineLearning;
  return {
    enabled: ml.enabled && ml.facialRecognition.enabled,
    maxDistance: ml.facialRecognition.maxDistance,
    minFaces: ml.facialRecognition.minFaces,
  };
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

interface FaceForRecognition {
  id: string;
  person_group_id: string | null;
  source_type: string;
  cluster_group_id: string;
  owner_id: string;
  visibility: string;
  file_created_at: string;
  embedding: ArrayBuffer | null;
}

interface Match {
  id: string;
  score: number;
  person_group_id: string | null;
}

/**
 * Immich searchFaces: the nearest faces (cosine distance <= maxDistance) on non-trashed assets of the cluster group,
 * skipping faces of a person born after `fileCreatedAt`, nearest first. Candidates come from Vectorize (namespace =
 * cluster group) plus the hub's buffer of recently written faces (exact cosine), so a vector Vectorize has not indexed
 * yet still counts; D1 decides what is eligible. The face itself is always a candidate, as in Immich. Unlike Immich,
 * soft-deleted and invisible faces never match.
 */
export async function searchFaces(
  env: Env,
  store: VectorStore | undefined,
  buffer: BufferedFace[],
  face: { id: string; clusterGroupId: string; embedding: number[]; fileCreatedAt: string },
  opts: { maxDistance: number; numResults: number; hasPerson?: boolean },
): Promise<Match[]> {
  const minScore = 1 - opts.maxDistance;
  const scores = new Map<string, number>([[face.id, 1]]);
  const add = (id: string, score: number) => {
    if (score >= minScore && score > (scores.get(id) ?? -Infinity)) scores.set(id, score);
  };
  if (store) {
    // hasPerson reads only vectors flagged `assigned` (syncFaceVectors), so unassigned neighbours cannot crowd them out
    const matches = opts.hasPerson
      ? await store.query(face.embedding, { topK: HAS_PERSON_TOP_K, namespace: face.clusterGroupId, filter: { assigned: '1' } })
      : await store.query(face.embedding, { topK: Math.max(NEIGHBOUR_TOP_K, opts.numResults * 4), namespace: face.clusterGroupId });
    for (const m of matches) add(m.id, m.score);
  }
  for (const b of buffer) add(b.id, cosine(face.embedding, b.values));

  const { results } = await env.DB.prepare(
    `SELECT f.id, f.person_group_id FROM asset_faces f
     JOIN assets a ON a.id = f.asset_id AND a.deleted_at IS NULL
     WHERE f.id IN (SELECT value FROM json_each(?1)) AND f.cluster_group_id = ?2 AND f.deleted_at IS NULL AND f.is_visible = 1
       ${opts.hasPerson ? 'AND f.person_group_id IS NOT NULL' : ''}
       AND NOT EXISTS (SELECT 1 FROM people p WHERE p.person_group_id = f.person_group_id AND p.birth_date IS NOT NULL AND p.birth_date > ?3)`,
  )
    .bind(JSON.stringify([...scores.keys()]), face.clusterGroupId, face.fileCreatedAt.slice(0, 10))
    .all<{ id: string; person_group_id: string | null }>();
  return results
    .map((r) => ({ id: r.id, person_group_id: r.person_group_id, score: scores.get(r.id)! }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, opts.numResults);
}

/**
 * Immich handleRecognizeFaces for one face. A core face (at least `minFaces` matches including itself, on a timeline
 * asset) joins the nearest matched person or founds one; a non-core face is deferred on the first pass and on the
 * second pass may only join an existing person. Faces that already have a person (assigned by hand or earlier) and
 * non-machine faces are skipped, which is what keeps manual assignments through every automatic pass.
 */
export async function recognizeFace(
  env: Env,
  settings: ClusterSettings,
  buffer: BufferedFace[],
  faceId: string,
  deferred: boolean,
  /** Called with a face once it is assigned, so the hub can search it exactly until Vectorize has indexed its new flag. */
  remember?: (face: BufferedFace) => void,
): Promise<RecognizeResult> {
  const face = await env.DB.prepare(
    `SELECT f.id, f.person_group_id, f.source_type, f.cluster_group_id, a.owner_id, a.visibility, a.file_created_at, e.embedding
     FROM asset_faces f JOIN assets a ON a.id = f.asset_id LEFT JOIN face_embeddings e ON e.face_id = f.id
     WHERE f.id = ?1 AND f.deleted_at IS NULL`,
  )
    .bind(faceId)
    .first<FaceForRecognition>();
  if (!face || face.source_type !== 'machine-learning' || !face.embedding) return 'skipped';
  if (face.person_group_id) {
    // Already assigned, possibly by an attempt that failed after its D1 commit: finish that attempt's side effects.
    await syncFaceVectors(env, [face.id]);
    const owner = await env.DB.prepare("SELECT 1 AS ok FROM people WHERE person_group_id = ?1 AND face_id = ?2 AND thumbnail_key = ''")
      .bind(face.person_group_id, face.id)
      .first();
    if (owner) await requestPersonThumbnail(env, face.person_group_id);
    return 'skipped';
  }

  const store = vectorStore(env, 'face');
  const embedding = fromBlob(face.embedding);
  const target = { id: face.id, clusterGroupId: face.cluster_group_id, embedding, fileCreatedAt: face.file_created_at };
  const matches = await searchFaces(env, store, buffer, target, { maxDistance: settings.maxDistance, numResults: settings.minFaces });
  if (settings.minFaces > 1 && matches.length <= 1) return 'skipped';

  const isCore = matches.length >= settings.minFaces && face.visibility === 'timeline';
  if (!isCore && !deferred) return 'deferred';

  let personGroupId = matches.find((m) => m.person_group_id)?.person_group_id ?? undefined;
  if (!personGroupId) {
    const [withPerson] = await searchFaces(env, store, buffer, target, { maxDistance: settings.maxDistance, numResults: 1, hasPerson: true });
    personGroupId = withPerson?.person_group_id ?? undefined;
  }

  const now = new Date().toISOString();
  const items: Array<Tracked | D1PreparedStatement> = [];
  if (!personGroupId) {
    if (!isCore) return 'skipped';
    personGroupId = crypto.randomUUID();
    items.push(insertGroup(env.DB, personGroupId, face.cluster_group_id, now));
  }
  const existing = await env.DB.prepare('SELECT 1 AS ok FROM people WHERE owner_id = ?1 AND person_group_id = ?2')
    .bind(face.owner_id, personGroupId)
    .first();
  if (!existing) items.push(insertPerson({ ownerId: face.owner_id, personGroupId, faceId: face.id }, now, { ifMissing: true }));
  items.push(assignFace(face.id, personGroupId, now, { onlyIfUnassigned: true }));
  await commit(env.DB, items);
  await syncFaceVectors(env, [face.id]);
  remember?.({ id: face.id, values: embedding });
  if (!existing) await requestPersonThumbnail(env, personGroupId);
  return 'assigned';
}

/** Forced re-cluster, first step (Immich unassignFaces with sourceType machine-learning): up to `limit` faces per call. Returns how many it reset. */
export async function unassignMachineFaces(
  env: Env,
  clusterGroupId: string,
  limit = 200,
  hooks: { before?: (ids: string[]) => void; after?: (ids: string[]) => void } = {},
): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT id FROM asset_faces WHERE cluster_group_id = ?1 AND source_type = 'machine-learning' AND person_group_id IS NOT NULL LIMIT ?2`,
  )
    .bind(clusterGroupId, limit)
    .all<{ id: string }>();
  const ids = results.map((f) => f.id);
  const now = new Date().toISOString();
  hooks.before?.(ids);
  await commitChunked(env.DB, ids.map((id) => assignFace(id, null, now)));
  await syncFaceVectors(env, ids);
  hooks.after?.(ids);
  return ids.length;
}

export { personCleanup };

/** A page of unassigned machine faces of the group (the `asset_faces_unassigned` index), ids after `after`. */
export async function unassignedFaceIds(env: Env, clusterGroupId: string, after: string, limit = 200): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT id FROM asset_faces WHERE cluster_group_id = ?1 AND id > ?2 AND person_group_id IS NULL
       AND source_type = 'machine-learning' AND deleted_at IS NULL AND is_visible = 1 ORDER BY id LIMIT ?3`,
  )
    .bind(clusterGroupId, after, limit)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

function hub(env: Env, clusterGroupId: string) {
  return env.CLUSTER_HUB.get(env.CLUSTER_HUB.idFromName(clusterGroupId));
}

/** New faces from detection (Task D calls the hub directly with the same body). */
export async function clusterNewFaces(env: Env, clusterGroupId: string, faceIds: string[]): Promise<void> {
  if (faceIds.length === 0) return;
  await hub(env, clusterGroupId).fetch('https://cluster-hub/faces', { method: 'POST', body: JSON.stringify({ faceIds }) });
}

/**
 * Immich FacialRecognitionQueueAll for one cluster group (admin "start"/"missing", nightly run): `force` unassigns
 * every machine-learning face first, removes people left without faces, then clusters all unassigned faces.
 */
export interface ClusterStatus {
  pending: number;
  deferred: number;
  scanning: boolean;
  resetting: boolean;
  running: boolean;
}

/** The hub's queue sizes and whether a run is in progress (`GET /status`). */
export async function clusterStatus(env: Env, clusterGroupId: string): Promise<ClusterStatus> {
  return (await hub(env, clusterGroupId).fetch('https://cluster-hub/status')).json<ClusterStatus>();
}

export async function requestClustering(env: Env, clusterGroupId: string, opts: { force: boolean }): Promise<void> {
  await hub(env, clusterGroupId).fetch('https://cluster-hub/run', { method: 'POST', body: JSON.stringify({ clusterGroupId, force: opts.force }) });
}
