CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('on_this_day', 'birthday')),
  data TEXT NOT NULL DEFAULT '{}',
  is_saved INTEGER NOT NULL DEFAULT 0,
  memory_at TEXT NOT NULL,
  seen_at TEXT,
  show_at TEXT,
  hide_at TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  update_id TEXT NOT NULL
);
CREATE INDEX memories_owner_update ON memories (owner_id, update_id);

CREATE TABLE memory_assets (
  memory_id TEXT NOT NULL REFERENCES memories (id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  update_id TEXT NOT NULL,
  PRIMARY KEY (memory_id, asset_id)
);
CREATE INDEX memory_assets_asset ON memory_assets (asset_id);
CREATE INDEX memory_assets_update ON memory_assets (update_id);

CREATE TABLE memory_audit (id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, user_id TEXT NOT NULL, deleted_at TEXT NOT NULL);
CREATE INDEX memory_audit_user ON memory_audit (user_id, id);

CREATE TABLE memory_asset_audit (
  id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, asset_id TEXT NOT NULL, owner_id TEXT NOT NULL, deleted_at TEXT NOT NULL
);
CREATE INDEX memory_asset_audit_owner ON memory_asset_audit (owner_id, id);
