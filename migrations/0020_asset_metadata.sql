ALTER TABLE asset_exif ADD COLUMN locked_properties TEXT;

CREATE TABLE asset_metadata (
  asset_id TEXT NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  update_id TEXT NOT NULL,
  PRIMARY KEY (asset_id, key)
);
CREATE INDEX asset_metadata_owner_update ON asset_metadata (owner_id, update_id);

CREATE TABLE asset_metadata_audit (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  key TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL
);
CREATE INDEX asset_metadata_audit_owner ON asset_metadata_audit (owner_id, id);
