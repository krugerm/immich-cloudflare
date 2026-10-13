-- Phase 4: faces and people (docs/research/2026-10-13-phase4-faces.md section 5.2).
-- One cluster group per user for now: cluster_group_id is the owner's user id.

ALTER TABLE assets ADD COLUMN faces_recognized_at TEXT;

CREATE TABLE person_groups (
  id TEXT PRIMARY KEY,
  cluster_group_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX person_groups_cluster ON person_groups (cluster_group_id);

CREATE TABLE people (
  owner_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  person_group_id TEXT NOT NULL REFERENCES person_groups (id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  birth_date TEXT,
  is_hidden INTEGER NOT NULL DEFAULT 0,
  is_favorite INTEGER NOT NULL DEFAULT 0,
  color TEXT,
  face_id TEXT,
  thumbnail_key TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  update_id TEXT NOT NULL,
  PRIMARY KEY (owner_id, person_group_id)
);
CREATE INDEX people_owner_update ON people (owner_id, update_id);
CREATE INDEX people_group ON people (person_group_id);
CREATE TABLE person_audit (id TEXT PRIMARY KEY, person_group_id TEXT NOT NULL, owner_id TEXT NOT NULL, deleted_at TEXT NOT NULL);
CREATE INDEX person_audit_owner ON person_audit (owner_id, id);

CREATE TABLE asset_faces (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  cluster_group_id TEXT NOT NULL,
  person_group_id TEXT,
  image_width INTEGER NOT NULL,
  image_height INTEGER NOT NULL,
  x1 INTEGER NOT NULL,
  y1 INTEGER NOT NULL,
  x2 INTEGER NOT NULL,
  y2 INTEGER NOT NULL,
  score REAL,
  source_type TEXT NOT NULL DEFAULT 'machine-learning' CHECK (source_type IN ('machine-learning', 'exif', 'manual')),
  is_visible INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  updated_at TEXT NOT NULL,
  update_id TEXT NOT NULL
);
CREATE INDEX asset_faces_asset ON asset_faces (asset_id);
CREATE INDEX asset_faces_group ON asset_faces (person_group_id, asset_id) WHERE deleted_at IS NULL AND is_visible = 1;
CREATE INDEX asset_faces_cluster_update ON asset_faces (cluster_group_id, update_id);
CREATE INDEX asset_faces_owner_update ON asset_faces (owner_id, update_id);
CREATE INDEX asset_faces_unassigned ON asset_faces (cluster_group_id, id)
  WHERE person_group_id IS NULL AND source_type = 'machine-learning' AND deleted_at IS NULL AND is_visible = 1;
CREATE TABLE asset_face_audit (
  id TEXT PRIMARY KEY,
  face_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  cluster_group_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL
);
CREATE INDEX asset_face_audit_cluster ON asset_face_audit (cluster_group_id, id);

-- 512 x float32 little-endian (2048 bytes); Vectorize index FACE_INDEX mirrors it.
CREATE TABLE face_embeddings (
  face_id TEXT PRIMARY KEY REFERENCES asset_faces (id) ON DELETE CASCADE,
  embedding BLOB NOT NULL
);
