-- Stream C: album comments and likes. An asset activity needs the asset to be in the album.
CREATE TABLE activities (
  id TEXT PRIMARY KEY,
  album_id TEXT NOT NULL REFERENCES albums (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  asset_id TEXT REFERENCES assets (id) ON DELETE CASCADE,
  comment TEXT,
  is_liked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((comment IS NULL AND is_liked = 1) OR (comment IS NOT NULL AND is_liked = 0)),
  FOREIGN KEY (album_id, asset_id) REFERENCES album_assets (album_id, asset_id) ON DELETE CASCADE
);
CREATE INDEX activities_album ON activities (album_id, created_at);
CREATE UNIQUE INDEX activities_one_like ON activities (album_id, ifnull(asset_id, ''), user_id) WHERE is_liked = 1;
