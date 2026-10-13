-- Phase 4: vector ids to remove from Vectorize after a purge commit (retried by the next purge run, like r2_delete_queue).
CREATE TABLE vector_delete_queue (
  index_name TEXT NOT NULL CHECK (index_name IN ('clip', 'face')),
  vector_id TEXT NOT NULL,
  queued_at TEXT NOT NULL,
  PRIMARY KEY (index_name, vector_id)
);
