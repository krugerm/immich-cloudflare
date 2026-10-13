-- Phase 2 stream A: users and auth.
ALTER TABLE users ADD COLUMN should_change_password INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN pin_code TEXT;
ALTER TABLE users ADD COLUMN profile_image_path TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE users ADD COLUMN license TEXT;

ALTER TABLE sessions ADD COLUMN pin_expires_at TEXT;
ALTER TABLE sessions ADD COLUMN expires_at TEXT;
ALTER TABLE sessions ADD COLUMN parent_id TEXT REFERENCES sessions (id) ON DELETE CASCADE;
ALTER TABLE sessions ADD COLUMN is_pending_sync_reset INTEGER NOT NULL DEFAULT 0;
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_sha256 TEXT NOT NULL UNIQUE,
  permissions TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX api_keys_user ON api_keys (user_id);
