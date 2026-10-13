-- One row holding the JSON difference between the admin's config and Immich's defaults.
CREATE TABLE system_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
