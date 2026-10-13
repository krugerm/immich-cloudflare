-- Stream C: shared links. `key` is the share key as base64url (Immich returns it in every response).
CREATE TABLE shared_links (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  key TEXT NOT NULL UNIQUE,
  slug TEXT UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('ALBUM', 'INDIVIDUAL')),
  album_id TEXT REFERENCES albums (id) ON DELETE CASCADE,
  description TEXT,
  password_hash TEXT,
  expires_at TEXT,
  allow_upload INTEGER NOT NULL DEFAULT 0,
  allow_download INTEGER NOT NULL DEFAULT 1,
  show_metadata INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX shared_links_user ON shared_links (user_id, created_at);
CREATE INDEX shared_links_album ON shared_links (album_id);

CREATE TABLE shared_link_assets (
  shared_link_id TEXT NOT NULL REFERENCES shared_links (id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  PRIMARY KEY (shared_link_id, asset_id)
);
CREATE INDEX shared_link_assets_asset ON shared_link_assets (asset_id);
