-- Stream C: albums. Like Immich 3.3, the owner is the album_users row with role 'owner'.
CREATE TABLE albums (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  thumbnail_asset_id TEXT,
  asset_order TEXT NOT NULL DEFAULT 'desc' CHECK (asset_order IN ('asc', 'desc')),
  is_activity_enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  update_id TEXT NOT NULL
);
CREATE INDEX albums_update ON albums (update_id);

CREATE TABLE album_users (
  album_id TEXT NOT NULL REFERENCES albums (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  create_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  update_id TEXT NOT NULL,
  PRIMARY KEY (album_id, user_id)
);
CREATE UNIQUE INDEX album_users_one_owner ON album_users (album_id) WHERE role = 'owner';
CREATE INDEX album_users_user ON album_users (user_id, create_id);
CREATE INDEX album_users_update ON album_users (update_id);

CREATE TABLE album_assets (
  album_id TEXT NOT NULL REFERENCES albums (id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  update_id TEXT NOT NULL,
  PRIMARY KEY (album_id, asset_id)
);
CREATE INDEX album_assets_asset ON album_assets (asset_id);
CREATE INDEX album_assets_album_update ON album_assets (album_id, update_id);
CREATE INDEX album_assets_update ON album_assets (update_id);

CREATE TABLE album_audit (id TEXT PRIMARY KEY, album_id TEXT NOT NULL, user_id TEXT NOT NULL, deleted_at TEXT NOT NULL);
CREATE INDEX album_audit_user ON album_audit (user_id, id);

CREATE TABLE album_user_audit (id TEXT PRIMARY KEY, album_id TEXT NOT NULL, user_id TEXT NOT NULL, deleted_at TEXT NOT NULL);
CREATE INDEX album_user_audit_album ON album_user_audit (album_id, id);

CREATE TABLE album_asset_audit (
  id TEXT PRIMARY KEY,
  album_id TEXT NOT NULL REFERENCES albums (id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL
);
CREATE INDEX album_asset_audit_album ON album_asset_audit (album_id, id);

-- Album asset update passes scan assets and EXIF of every owner by cursor.
CREATE INDEX assets_update_id ON assets (update_id);
CREATE INDEX asset_exif_update_id ON asset_exif (update_id);
