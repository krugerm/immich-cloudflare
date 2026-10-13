CREATE TABLE partners (
  shared_by_id TEXT NOT NULL REFERENCES users (id),
  shared_with_id TEXT NOT NULL REFERENCES users (id),
  in_timeline INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  create_id TEXT NOT NULL,
  update_id TEXT NOT NULL,
  PRIMARY KEY (shared_by_id, shared_with_id)
);
CREATE INDEX partners_shared_with ON partners (shared_with_id, create_id);
CREATE INDEX partners_update ON partners (update_id);

CREATE TABLE partner_audit (id TEXT PRIMARY KEY, shared_by_id TEXT NOT NULL, shared_with_id TEXT NOT NULL, deleted_at TEXT NOT NULL);
CREATE INDEX partner_audit_shared_by ON partner_audit (shared_by_id, id);
CREATE INDEX partner_audit_shared_with ON partner_audit (shared_with_id, id);
