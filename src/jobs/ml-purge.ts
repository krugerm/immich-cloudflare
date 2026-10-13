// Phase 4 Task G: what a purge removes beyond the asset row: embeddings, faces (with audits), vector ids, and people
// left without faces. The statements run inside the purge commit under the purge's own restore guard; the vectors are
// deleted from Vectorize after the commit, from vector_delete_queue (the same pattern as r2_delete_queue).
import type { RowGuard } from '../albums/repo';
import { tracked, type Tracked } from '../db/changes';
import { vectorStore, type VectorKind } from '../ml/vectors';

interface FaceRow { id: string; asset_id: string; owner_id: string; cluster_group_id: string; person_group_id: string | null }

const VECTOR_MAX = 1000;
const NO_FACES = 'NOT EXISTS (SELECT 1 FROM asset_faces WHERE person_group_id = ?1 AND deleted_at IS NULL)';

/**
 * Statements for the assets about to be purged: audit and queue their faces, delete embeddings and faces explicitly
 * (no foreign-key cascade), then delete people that end up with no face (Immich's person cleanup), with their
 * audit row and thumbnail key, and clear a surviving person's feature face when that face is gone.
 * Every per-asset statement re-checks `guardFor(asset)`; person statements check the faces themselves, so a person whose
 * face survives because its asset was restored is kept. Place them before the asset deletes.
 */
export async function mlPurgeItems(
  env: Env,
  assets: Array<{ id: string; owner_id: string }>,
  deletedAt: string,
  guardFor: (assetId: string) => RowGuard,
  /** Forced face detection: only machine-learning faces go; the embedding, clip vector and manual or exif faces stay. */
  machineFacesOnly = false,
): Promise<Array<Tracked | D1PreparedStatement>> {
  if (assets.length === 0) return [];
  const ml = machineFacesOnly ? " AND source_type = 'machine-learning'" : '';
  const { results: faces } = await env.DB
    .prepare(`SELECT id, asset_id, owner_id, cluster_group_id, person_group_id FROM asset_faces WHERE asset_id IN (SELECT value FROM json_each(?1))${ml}`)
    .bind(JSON.stringify(assets.map((a) => a.id)))
    .all<FaceRow>();
  const byAsset = new Map<string, FaceRow[]>();
  for (const f of faces) byAsset.set(f.asset_id, [...(byAsset.get(f.asset_id) ?? []), f]);
  const { results: featured } = faces.length
    ? await env.DB
        .prepare('SELECT owner_id, person_group_id, face_id FROM people WHERE face_id IN (SELECT value FROM json_each(?1))')
        .bind(JSON.stringify(faces.map((f) => f.id)))
        .all<{ owner_id: string; person_group_id: string; face_id: string }>()
    : { results: [] };

  const db = env.DB;
  const items: Array<Tracked | D1PreparedStatement> = [];
  for (const a of assets) {
    const g = guardFor(a.id);
    for (const f of byAsset.get(a.id) ?? []) {
      items.push(
        tracked(
          `INSERT INTO asset_face_audit (id, face_id, asset_id, owner_id, cluster_group_id, deleted_at)
           SELECT :cursor, ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM asset_faces WHERE id = ?1) AND ${g.sql('?6')}`,
          f.id, a.id, f.owner_id, f.cluster_group_id, deletedAt, g.value,
        ),
      );
    }
    items.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO vector_delete_queue (index_name, vector_id, queued_at)
           SELECT 'face', id, ?2 FROM asset_faces WHERE asset_id = ?1${ml} AND ${g.sql('?3')}`,
        )
        .bind(a.id, deletedAt, g.value),
      db.prepare(`DELETE FROM face_embeddings WHERE face_id IN (SELECT id FROM asset_faces WHERE asset_id = ?1${ml}) AND ${g.sql('?2')}`).bind(a.id, g.value),
      db.prepare(`DELETE FROM asset_faces WHERE asset_id = ?1${ml} AND ${g.sql('?2')}`).bind(a.id, g.value),
    );
    if (!machineFacesOnly) {
      items.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO vector_delete_queue (index_name, vector_id, queued_at)
             SELECT 'clip', ?1, ?2 WHERE (EXISTS (SELECT 1 FROM smart_search WHERE asset_id = ?1) OR EXISTS (SELECT 1 FROM assets WHERE id = ?1 AND ml_at IS NOT NULL))
               AND ${g.sql('?3')}`,
          )
          .bind(a.id, deletedAt, g.value),
        db.prepare(`DELETE FROM smart_search WHERE asset_id = ?1 AND ${g.sql('?2')}`).bind(a.id, g.value),
      );
    }
  }

  // people: one pass after every face delete above, so a person whose last faces sit in different assets of this batch is seen empty
  const groups = new Map<string, { owner: string; asset: string }>();
  for (const f of faces) if (f.person_group_id) groups.set(f.person_group_id, { owner: f.owner_id, asset: f.asset_id });
  for (const [pg, { owner, asset }] of groups) {
    const exists = 'EXISTS (SELECT 1 FROM people WHERE person_group_id = ?1 AND owner_id = ?2)';
    items.push(
      tracked(
        `INSERT INTO person_audit (id, person_group_id, owner_id, deleted_at) SELECT :cursor, ?1, ?2, ?3 WHERE ${exists} AND ${NO_FACES}`,
        pg, owner, deletedAt,
      ),
      // the thumbnail (Task D stores it at people/<personGroupId>.jpeg) is deleted after the commit; keyed to the purged asset
      db
        .prepare(`INSERT OR IGNORE INTO r2_delete_queue (key, asset_id, queued_at) SELECT 'people/' || ?1 || '.jpeg', ?3, ?4 WHERE ${exists} AND ${NO_FACES}`)
        .bind(pg, owner, asset, deletedAt),
      db.prepare(`DELETE FROM people WHERE person_group_id = ?1 AND owner_id = ?2 AND ${NO_FACES}`).bind(pg, owner),
      db
        .prepare(
          `DELETE FROM person_groups WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM people WHERE person_group_id = ?1)
             AND NOT EXISTS (SELECT 1 FROM asset_faces WHERE person_group_id = ?1)`,
        )
        .bind(pg),
    );
  }
  for (const p of featured) {
    items.push(
      tracked(
        `UPDATE people SET face_id = NULL, updated_at = ?4, update_id = :cursor
         WHERE owner_id = ?1 AND person_group_id = ?2 AND face_id = ?3 AND NOT EXISTS (SELECT 1 FROM asset_faces WHERE id = ?3)`,
        p.owner_id, p.person_group_id, p.face_id, deletedAt,
      ),
    );
  }
  return items;
}

/**
 * Deletes queued vector ids from Vectorize, then their queue rows. Leftovers from runs whose delete failed are picked up
 * by the next call. Does nothing for an index that is not bound (the ids stay queued).
 */
export async function deleteQueuedVectors(env: Env, pages = 10): Promise<void> {
  for (const kind of ['clip', 'face'] as VectorKind[]) {
    const store = vectorStore(env, kind);
    if (!store) continue;
    for (let page = 0; page < pages; page++) {
      const { results } = await env.DB
        .prepare('SELECT vector_id FROM vector_delete_queue WHERE index_name = ?1 ORDER BY queued_at LIMIT ?2')
        .bind(kind, VECTOR_MAX)
        .all<{ vector_id: string }>();
      if (results.length === 0) break;
      const ids = results.map((r) => r.vector_id);
      await store.deleteByIds(ids);
      await env.DB
        .prepare('DELETE FROM vector_delete_queue WHERE index_name = ?1 AND vector_id IN (SELECT value FROM json_each(?2))')
        .bind(kind, JSON.stringify(ids))
        .run();
      if (results.length < VECTOR_MAX) break;
    }
  }
}
