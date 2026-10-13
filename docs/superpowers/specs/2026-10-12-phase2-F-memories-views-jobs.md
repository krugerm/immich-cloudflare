# Phase 2 stream F: memories, views, server extras, jobs and queues

Migrations 0060 to 0061. Reference: Immich `memory.service.ts`, `memory.repository.ts`, `view.service.ts`, `server.service.ts`, `queue.service.ts`, `job.service.ts`.

## Tables

`0060_memories.sql`
- `memories` (synced): id, owner_id, type (`on_this_day` | `birthday`), data (JSON text), is_saved, memory_at, seen_at, show_at, hide_at, deleted_at (always NULL, Immich hard-deletes), created_at, updated_at, update_id.
- `memory_assets` (synced): (memory_id, asset_id), update_id. Cascades from both parents.
- `memory_audit`: id (cursor), memory_id, user_id, deleted_at. Written with `tracked` when a memory is deleted.
- `memory_asset_audit`: id (cursor), memory_id, asset_id, owner_id, deleted_at. Written when assets are removed from a memory. Immich filters this stream by "memory belongs to user"; the owner column makes it work after the memory is gone.

`0061_server_state.sql`
- `server_state` (key, value, updated_at): license, memories-generation state, queue pause flags.

## Endpoints

- Memories: CRUD, add/remove assets, statistics. Access is owner-only; missing or foreign memory returns 400 `Not found or no memory.<perm> access` as Immich does. Assets in responses are timeline-visible, not trashed, ordered by file_created_at. Search honours for/id/isSaved/isTrashed/isUpcoming/type/size/page/order (random supported) and hides memories without visible assets.
- On this day generation (`generateMemories`, daily cron, also `POST /jobs memory-create`): Immich's algorithm. For each of today-3 .. today+3 not past `lastOnThisDayDate`, per user and per earlier year with assets on that month-day (timeline, not trashed, thumbnail ready, max 20 per year) create a memory with data `{year}`, showAt start of day UTC, hideAt end of day UTC. Birthday memories need people (ML, not in this system) and are not generated; `POST /memories` still accepts `type: birthday` with personId and personName.
- Cleanup (`cleanupMemories`, daily cron, `POST /jobs memory-cleanup`): drops memory assets that are no longer timeline-visible and unsaved memories older than 30 days.
- Sync: `MemoriesV2` = `MemoryDeleteV1` + `MemoryV2`; `MemoryToAssetsV2` = `MemoryToAssetDeleteV1` + `MemoryToAssetV2`, placed after the exif types in Immich's order. V1 request types are not added (clients 3.3 use V2).
- Purging a trashed asset cascades its `memory_assets` rows without an audit row; clients drop their rows when `AssetDeleteV1` arrives.
- Views: `original_path` is `originals/<ownerId>/<assetId>.<ext>`. Immich's algorithm runs on it unchanged (directory of original_path, trailing slash removed; children by path, ordered by file name; matched with instr() because D1 rejects LIKE patterns over 50 bytes), so every user sees one folder `originals/<ownerId>` holding all timeline assets. This matches what `originalPath` reports on assets and what an Immich upload-only library shows (one hashed upload folder per user, without the hashing).
- Server: `GET/PUT/DELETE /server/license` (admin). Keys are verified against Immich's production license public key with WebCrypto (RSASSA-PKCS1-v1_5 SHA-256), same rule as Immich: `IMSV-` prefix, 400 otherwise; GET without a license is 404. `/server/about` reports `licensed`. `GET /server/apk-links` mirrors Immich's GitHub URLs for `SERVER_VERSION`. `GET /server/version-check` returns `{checkedAt: null, releaseVersion: null}` (no outbound calls). `GET /server/statistics` already exists from phase 1.
- Queues/jobs (admin): all 19 Immich queue names.
  - `thumbnailGeneration` and `metadataExtraction` both describe the single `asset-process` pipeline: waiting = assets with status `pending`, failed = `failed`, completed = `ready`.
  - `backupDatabase` describes the asset backup queue: waiting = non-pending, non-trashed assets without `backed_up_at`.
  - Other queues report zeros. `active`, `delayed` are always 0 (Cloudflare Queues expose no live counts).
  - `start`: process queues enqueue `pending`/`failed` assets (force: every non-trashed asset, with a `force` flag that bypasses the `ready` short-circuit in the consumer); `backupDatabase` requeues missing backups; queues whose feature does not exist (videoConversion, smartSearch, duplicateDetection, faceDetection, facialRecognition, library, sidecar, ocr, storageTemplateMigration, migration) do nothing and return the queue state; queues Immich rejects (`backgroundTask`, `search`, `notifications`, `workflow`, `editor`, `integrityCheck`) return 400 as in Immich. A command enqueues at most 10,000 assets.
  - `pause`/`resume` persist a flag in `server_state` and show in the response; consumers do not honour it. Pausing `backgroundTask` is 400.
  - `empty` / `clear-failed` / `DELETE /queues/{name}/jobs` are accepted no-ops (messages in a Cloudflare Queue cannot be removed from a Worker; failed state is the asset row).
  - `GET /queues/{name}/jobs` lists process-queue assets as `AssetGenerateThumbnails` / `AssetExtractMetadata` jobs (status waiting/failed/completed filter, max 1,000).
  - `POST /jobs`: `backup-database` requeues missing backups; `memory-create` / `memory-cleanup` run now; person/tag/user cleanup and integrity jobs are accepted no-ops.
  - Legacy `/jobs` and `PUT /jobs/{name}` are the same data in the legacy shape.

## Shared-module edits

- `src/upload/routes.ts` `ProcessMessage`: optional `force`. `src/process/consumer.ts`: `processAsset(..., force)` skips the `ready` short-circuit.
- `src/server/routes.ts`: `licensed` in `/server/about`.
- `src/assets/routes.ts`, `src/admin/routes.ts`: phase 1 stubs removed.

## Fix round 1

- `0062_memory_unique.sql`: unique index on (owner_id, memory_at, show_at) for on-this-day memories; creation is `INSERT OR IGNORE` and memory assets are inserted only when the memory exists. `POST /memories` returns 400 on a duplicate key.
- Generation creates at most 100 memories per run; the stored day advances only when that day is complete, and progress is the set of memories that already exist, so the next run continues.
- Queue `start` selects at most 4,000 assets per call in id order and keeps a cursor row (`start_cursor:<queue>:<all|missing>`); repeated starts continue, a short batch resets it. A paused queue ignores `start`; pause does not hold back messages already queued.
- Asset purge writes `memory_asset_audit` rows (`memoryAssetPurgeAudit`, called from `src/cron/purge.ts`).
- The de-dup DELETE in 0062 writes no `memory_audit` rows: the memories table is created in 0060 within the same never-deployed release, so no client can have synced a duplicate before 0062 runs. Any future de-dup migration on a deployed table must write `memory_audit` rows.
