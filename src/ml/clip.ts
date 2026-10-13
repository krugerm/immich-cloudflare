import type { AssetRow } from '../db/rows';
import { CLIP_MODEL, toBlob } from './contract';
import { vectorStore } from './vectors';

/**
 * Stores the SigLIP2 embedding: D1 `smart_search` (source of truth) and the clip vector index, with the owner as
 * metadata for the search-time owner filter. Hidden assets (live-photo videos) are not embedded, as in Immich.
 */
export async function storeClip(env: Env, a: AssetRow, embedding: number[]): Promise<void> {
  if (a.visibility === 'hidden') return;
  await env.DB.prepare(
    `INSERT INTO smart_search (asset_id, embedding, model) VALUES (?1, ?2, ?3)
     ON CONFLICT (asset_id) DO UPDATE SET embedding = excluded.embedding, model = excluded.model`,
  )
    .bind(a.id, toBlob(embedding), CLIP_MODEL)
    .run();
  await vectorStore(env, 'clip')?.upsert([{ id: a.id, values: embedding, metadata: { ownerId: a.owner_id } }]);
}
