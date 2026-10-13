-- One on-this-day memory per owner, memory date and show date; makes generation idempotent.
-- The de-dup DELETE writes no memory_audit rows: the memories table is created in 0060 within the same never-deployed
-- release, so no client can have synced a duplicate before this migration runs. Any future de-dup migration on a
-- deployed table must write memory_audit rows.
DELETE FROM memories WHERE type = 'on_this_day' AND show_at IS NOT NULL AND rowid NOT IN (
  SELECT min(rowid) FROM memories WHERE type = 'on_this_day' AND show_at IS NOT NULL GROUP BY owner_id, memory_at, show_at
);
CREATE UNIQUE INDEX memories_on_this_day_key ON memories (owner_id, memory_at, show_at) WHERE type = 'on_this_day' AND show_at IS NOT NULL;
