CREATE TABLE seq (id INTEGER PRIMARY KEY CHECK (id = 1), v INTEGER NOT NULL);
INSERT INTO seq (id, v) VALUES (1, 0);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  is_onboarded INTEGER NOT NULL DEFAULT 1,
  avatar_color TEXT NOT NULL DEFAULT 'primary',
  profile_changed_at TEXT NOT NULL,
  quota_bytes INTEGER,
  usage_bytes INTEGER NOT NULL DEFAULT 0,
  storage_label TEXT,
  preferences TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  update_id TEXT NOT NULL
);
CREATE INDEX users_update ON users (update_id);

CREATE TABLE user_audit (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, deleted_at TEXT NOT NULL);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_sha256 TEXT NOT NULL UNIQUE,
  device_type TEXT NOT NULL DEFAULT '',
  device_os TEXT NOT NULL DEFAULT '',
  reset_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sync_checkpoints (
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  ack TEXT NOT NULL,
  PRIMARY KEY (session_id, entity_type)
);

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users (id),
  device_asset_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('IMAGE', 'VIDEO', 'AUDIO', 'OTHER')),
  original_path TEXT NOT NULL,
  original_file_name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  file_created_at TEXT NOT NULL,
  file_modified_at TEXT NOT NULL,
  local_date_time TEXT NOT NULL,
  duration INTEGER,
  is_favorite INTEGER NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL DEFAULT 'timeline',
  live_photo_video_id TEXT,
  thumbhash TEXT,
  width INTEGER,
  height INTEGER,
  file_size INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'needs_media', 'failed')),
  error TEXT,
  has_thumbnail INTEGER NOT NULL DEFAULT 0,
  backed_up_at TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  update_id TEXT NOT NULL
);
CREATE UNIQUE INDEX assets_owner_checksum ON assets (owner_id, checksum);
CREATE INDEX assets_owner_update ON assets (owner_id, update_id);
CREATE INDEX assets_owner_local_date ON assets (owner_id, local_date_time);

CREATE TABLE asset_exif (
  asset_id TEXT PRIMARY KEY REFERENCES assets (id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  make TEXT, model TEXT, lens_model TEXT, exposure_time TEXT,
  f_number REAL, focal_length REAL, iso INTEGER,
  latitude REAL, longitude REAL, city TEXT, state TEXT, country TEXT,
  date_time_original TEXT, modify_date TEXT, time_zone TEXT, orientation TEXT,
  rating INTEGER, description TEXT,
  exif_image_width INTEGER, exif_image_height INTEGER, file_size_in_byte INTEGER,
  profile_description TEXT, projection_type TEXT, fps REAL,
  update_id TEXT NOT NULL
);
CREATE INDEX asset_exif_owner_update ON asset_exif (owner_id, update_id);

CREATE TABLE asset_audit (id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, owner_id TEXT NOT NULL, deleted_at TEXT NOT NULL);
CREATE INDEX asset_audit_owner ON asset_audit (owner_id, id);
