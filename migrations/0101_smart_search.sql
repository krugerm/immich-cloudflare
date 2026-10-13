-- Phase 4: smart search embeddings and duplicate detection state.

-- 768 x float32 little-endian (3072 bytes) from ViT-B-16-SigLIP2__webli; Vectorize index CLIP_INDEX mirrors it.
CREATE TABLE smart_search (
  asset_id TEXT PRIMARY KEY REFERENCES assets (id) ON DELETE CASCADE,
  embedding BLOB NOT NULL,
  model TEXT NOT NULL
);

-- When the ML job last ran for the asset (embedding and faces); null means not yet.
ALTER TABLE assets ADD COLUMN ml_at TEXT;
ALTER TABLE assets ADD COLUMN duplicate_id TEXT;
ALTER TABLE assets ADD COLUMN duplicates_checked_at TEXT;
CREATE INDEX assets_owner_duplicate ON assets (owner_id, duplicate_id) WHERE duplicate_id IS NOT NULL;
CREATE INDEX assets_ml_pending ON assets (created_at) WHERE ml_at IS NULL AND status = 'ready';
