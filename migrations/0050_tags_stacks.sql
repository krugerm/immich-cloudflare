CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  value TEXT NOT NULL,
  color TEXT,
  parent_id TEXT REFERENCES tags (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, value)
);
CREATE INDEX tags_parent ON tags (parent_id);

CREATE TABLE tag_asset (
  tag_id TEXT NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  PRIMARY KEY (tag_id, asset_id)
);
CREATE INDEX tag_asset_asset ON tag_asset (asset_id);

ALTER TABLE assets ADD COLUMN stack_id TEXT;
CREATE INDEX assets_stack ON assets (stack_id);

CREATE TABLE stacks (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  primary_asset_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  update_id TEXT NOT NULL
);
CREATE INDEX stacks_owner_update ON stacks (owner_id, update_id);

CREATE TABLE stack_audit (id TEXT PRIMARY KEY, stack_id TEXT NOT NULL, owner_id TEXT NOT NULL, deleted_at TEXT NOT NULL);
CREATE INDEX stack_audit_owner ON stack_audit (owner_id, id);
