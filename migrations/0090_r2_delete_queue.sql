-- R2 keys of purged assets, written in the same D1 commit that deletes the rows. Objects are deleted after the
-- commit and the rows removed; anything left (an R2 failure) is retried by the next purge run.
CREATE TABLE r2_delete_queue (key TEXT PRIMARY KEY, asset_id TEXT NOT NULL, queued_at TEXT NOT NULL);
CREATE INDEX r2_delete_queue_asset ON r2_delete_queue (asset_id);
