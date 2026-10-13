# Immich-compatible server on Cloudflare: design

Date: 2026-10-12
Status: approved in brainstorming, pending written-spec review

## 1. Goal

A personal photo library for 1–2 users (under 500 GB) that runs on Cloudflare's serverless platform. It implements the Immich server API so the stock Immich mobile app and the Immich web app work against it unmodified.

Success criteria:

- Photos back up automatically from an iPhone with the stock Immich app.
- The library is browsable in the Immich app and in the Immich web app from any network.
- Originals live in R2, with a second R2 bucket as a weekly backup.
- No server to patch or keep running for the core path (login, upload, sync, browse).
- Running cost about $20–25/month at 500 GB.

Non-goals: multi-tenancy, a commercial offering, a forked mobile app, reuse of Immich server code.

## 2. Decisions

| Topic | Decision | Reason |
|---|---|---|
| Compatibility target | Immich mobile and web 3.3.x. The server reports version `3.3.0` | The app warns when the server version is lower than its own (`mobile/lib/providers/server_info.provider.dart`) |
| Scope | Broad parity, delivered in 5 phases (section 9) | Each phase is usable on its own |
| Web UI | Immich's web app, built unmodified, served from Workers static assets | The API work serves both clients |
| Auth | Own implementation of Immich's auth endpoints | The API contract is Immich's; a general auth library adds a second contract to wrap |
| Upload size | 100 MB per file through Cloudflare (Free/Pro plan limit). A Fly ingest proxy that removes the cap is in BACKLOG.md (deferred 2026-10-13) | The app sends each file in one multipart POST; Cloudflare's edge rejects larger bodies with 413 before the Worker runs |
| Smart search | EmbeddingGemma 2 (multimodal, 740M, Apache 2.0) in a Container | Workers AI has no image–text embedding model |
| Faces | Immich's `buffalo_l` pack (SCRFD-10G-KPS detector plus ArcFace R50, 512-d) from `immich-app/buffalo_l`, in ONNX in the same Container, with Immich's clustering defaults (maxDistance 0.5, minScore 0.7, minFaces 3). Phase 4 starts by timing it in the Container | EmbeddingGemma 2 embeds content, not identity. No open model beats it by more than 0.6 points TAR on IJB-C, it leads on AgeDB-30, and Immich's thresholds are tuned for it (docs/research/2026-10-13-face-models.md) |
| Video playback | Originals are served as uploaded; no transcoding (H.264 conversion is in BACKLOG.md). Realtime HLS streaming is not built and `realtimeTranscoding` stays false | HEVC plays in the iOS app and on macOS; on-the-fly transcoding in a Container is slow and costly |
| Licence | Personal use. Serving Immich's AGPL web app is fine for this audience | No distribution to third parties |

## 3. Architecture

```
iPhone (Immich app) ─┐
Browser (Immich web) ┴─► api Worker ──► D1  (catalogue, sessions, audit tables)
                           │  │  └────► R2  (originals, thumbs, encoded)
                           │  └─► Queue asset-process ─► process consumer Worker
                           │                               ├─► Images binding (thumbnails)
                           │                               └─► media / ml Containers (phases 3–4)
                           └─► Vectorize (phase 4)
Queue asset-backup ─► backup consumer ─► R2 immich-originals-backup (R2 bindings)
Cron Worker: trash purge and stale-pending requeue (daily), backup re-enqueue (weekly)
Fly ingest proxy (backlog): streams uploads to R2 with no size cap, forwards other requests to the api Worker
```

### 3.1 Units

| Unit | Responsibility | Depends on |
|---|---|---|
| `api` Worker | Immich REST API under `/api`; static Immich web build; auth middleware | D1, R2, Queue, Vectorize |
| `auth` module | Login, logout, token validation, password hashing, session lookup | D1 |
| `changes` module | The only writer for synced entities. Each write is one D1 `batch()` that bumps the cursor (section 4.0) and writes the entity, plus its audit row for hard deletes | D1 |
| `sync` module | `POST /sync/stream`, `POST /sync/ack`, `DELETE /sync/ack` | D1, `changes` tables |
| `upload` module | Streaming multipart parse, SHA-1, R2 multipart write, dedupe, enqueue | R2, D1, Queue |
| `process` consumer Worker | EXIF extraction, thumbnails, thumbhash, status updates | R2, Images, D1 (via `changes`) |
| `cron` Worker | Daily trash purge and re-enqueue of stale pending assets; weekly re-enqueue of assets missing a backup copy | R2, D1, Queue |
| `backup` consumer | Streams each ready original from the media bucket into the backup bucket through the R2 bindings | R2 (bindings), D1 |
| `media` Container (phase 3) | ffmpeg and libraw: video posters and metadata, RAW and images over 20 MB | R2 |
| `ml` Container (phase 4) | EmbeddingGemma 2 image and text embeddings; face detection and embeddings | R2 |
| `ingest` on Fly (backlog) | Uncapped upload path in front of the Worker | R2 (S3 API), `api` Worker |

API types are generated from `open-api/immich-openapi-specs.json` at the pinned Immich tag, as TypeScript types (openapi-typescript); tests validate responses against the OpenAPI document with an in-repo validator. Routing uses Hono.

## 4. Data model (D1)

Phase 1 tables:

| Table | Columns |
|---|---|
| `users` | `id` UUIDv4, `email` unique, `name`, `password_hash` (self-describing string `pbkdf2-sha256$100000$<salt>$<hash>`; 100,000 is the Workers runtime maximum for PBKDF2 iterations, and the prefix allows a later move to argon2id in WASM), `is_admin`, `is_onboarded`, `avatar_color`, `profile_changed_at` (non-null), `pin_code` (null), `oauth_id` (empty string), `quota_bytes`, `usage_bytes`, `storage_label`, `preferences` JSON, `created_at`, `updated_at`, `deleted_at`, `update_id` |
| `sessions` | `id` UUIDv4, `user_id`, `token_sha256` unique, `device_type`, `device_os`, `reset_at` (null), `created_at`, `updated_at` |
| `assets` | `id` UUIDv4, `owner_id`, `device_asset_id`, `device_id`, `type` (`IMAGE`/`VIDEO`), `original_path`, `original_file_name`, `checksum` (SHA-1, base64 text), `file_created_at`, `file_modified_at`, `local_date_time`, `duration`, `is_favorite`, `visibility`, `live_photo_video_id`, `stack_id` (null), `library_id` (null), `is_edited` (false), `thumbhash`, `width`, `height`, `file_size`, `status` (`pending`/`ready`/`needs_media`/`failed`), `error`, `has_thumbnail`, `backed_up_at`, `deleted_at`, `created_at`, `updated_at`, `update_id`. Unique index on `(owner_id, checksum)`; index on `(owner_id, update_id)` |
| `asset_exif` | `asset_id`, `owner_id`, `make`, `model`, `lens_model`, `exposure_time`, `f_number`, `focal_length`, `iso`, `latitude`, `longitude`, `city`, `state`, `country`, `date_time_original`, `modify_date`, `time_zone`, `orientation`, `rating`, `description`, `exif_image_width`, `exif_image_height`, `file_size_in_byte`, `profile_description`, `projection_type`, `fps`, `update_id`. Index on `(owner_id, update_id)` |
| `asset_audit` | `id` (update cursor), `asset_id`, `owner_id`, `deleted_at`. One row per hard-deleted asset, written by the purge job |
| `user_audit` | `id` (update cursor), `user_id`, `deleted_at` |
| `seq` | Single row `v INTEGER`, the source of all update cursors |
| `sync_checkpoints` | `session_id`, `entity_type` (ack type, e.g. `AssetV2`, `AssetDeleteV1`), `ack`, primary key `(session_id, entity_type)`, deleted with the session |

Later phases add `api_keys` (hashed with SHA-256, for `x-api-key`), `albums`, `album_assets`, `album_users`, `partners`, `shared_links`, `people`, `faces`, `tags`, `stacks` and `memories`. Each synced table carries `update_id` and an index on `(owner_id, update_id)`, gets an audit table for hard deletes, and is written through `changes`.

Entity IDs are UUIDv4, because Immich's OpenAPI patterns and DTOs require version-4 UUIDs.

### 4.0 Update cursors

`update_id` is assigned inside the D1 transaction, never in the Worker. Every `changes` write is one D1 `batch()`. For each row it writes (entity or audit), the batch contains a pair of statements: `UPDATE seq SET v = v + 1`, then the row write with `update_id = (SELECT '00000000-0000-7000-8000-' || printf('%012x', v) FROM seq)`. Every row therefore gets its own cursor, including in multi-row writes such as bulk trash, purge or a live-photo pair; shared cursors would let paging and acks skip rows. A test trashes two assets in one call that straddle a 500-row page boundary. D1 serialises writes, so cursor order equals commit order and a sync can never ack past an uncommitted lower cursor. The string is UUID-shaped, sorts lexicographically in numeric order, and carries version nibble 7 like Immich's cursors.

Size: about 1 KB per asset in D1, about 100 MB at 100k assets, against the 10 GB D1 limit. Audit tables hold one row per hard delete and are never pruned.

### 4.1 R2 layout

| Prefix | Content |
|---|---|
| `originals/<ownerId>/<assetId>.<ext>` | Uploaded file, never modified |
| `thumbs/<assetId>/thumbnail.webp` | 250 px |
| `thumbs/<assetId>/preview.jpeg` | 1440 px |
| `encoded/<assetId>.mp4` | Reserved for H.264 transcodes (BACKLOG.md) |
| `profile/<userId>.jpeg` | Profile images |

Object names carry no date folders. Each name is fixed when the upload starts, before EXIF is known, so the upload never needs a rename. A lifecycle rule aborts incomplete multipart uploads after 1 day.

## 5. Auth

- `POST /api/auth/login`: verify the password, create a session with a 32-byte random token, store its SHA-256, and return `LoginResponseDto` with `accessToken` set to the token and `isOnboarded` from the user. Store `deviceModel`/`deviceType` headers on the session. Logins are locked per account after 10 failed attempts in 15 minutes (D1 table `login_failures`).
- Login sets three cookies, all `Path=/`, `SameSite=Lax`, `Secure`, max-age 400 days: `immich_access_token` (HttpOnly), `immich_auth_type=password` (HttpOnly) and `immich_is_authenticated=true` (readable by JavaScript; the web app checks it to decide whether it is logged in). Logout clears all three.
- Token sources, checked in Immich's order: `x-immich-user-token` header, `x-immich-session-token` header, `sessionKey` query parameter, `Authorization: Bearer`, then the `immich_access_token` cookie (the mobile app's native HTTP stack and the web app send the cookie). Phase 2 adds `x-api-key`.
- `POST /api/auth/validateToken` returns `{authStatus: true}` or 401. `POST /api/auth/logout` deletes the session and its checkpoints.
- Admin bootstrap: `POST /api/auth/admin-sign-up` works only while `users` is empty. `/server/config` reports `isInitialized = (users not empty)`, which decides whether the web app shows the register or the login page. `isOnboarded` is reported as true and set on the user at sign-up, so the web app skips its onboarding flow.
- Login attempts are rate-limited per email and IP with the Workers rate-limiting binding.

## 6. Sync

The layout follows Immich's own server (`server/src/services/sync.service.ts`). Two kinds of type are kept apart:

- **Request types** are what the client asks for in `{types: [...]}`, e.g. `AuthUsersV2`, `UsersV1`, `AssetsV2`, `AssetExifsV1`.
- **Entity (ack) types** label each emitted line and key the checkpoints, e.g. `AuthUserV2`, `UserV1`, `UserDeleteV1`, `AssetV2`, `AssetDeleteV1`, `AssetExifV1`.

`POST /api/sync/stream` responds with `application/jsonlines+json`:

1. If the session needs a reset (section 6.1), emit only `{"type": "SyncResetV1", "data": {}, "ack": "SyncResetV1|reset"}` and end.
2. Read `nowId` (the current `seq` value as a cursor) once. Every query below is bounded by `update_id <= nowId`.
3. For each requested type the server implements, in Immich's order, run its passes. Each pass is one entity type and reads rows after that entity type's checkpoint, ordered by `update_id`, in pages of 500, flushing each page to the response:
   - `AssetsV2`: first the `AssetDeleteV1` pass over `asset_audit`, then the `AssetV2` pass over `assets` (upserts read the entity table directly).
   - `AssetExifsV1`: the `AssetExifV1` pass over `asset_exif`.
   - `UsersV1`: `UserDeleteV1` over `user_audit`, then `UserV1` over `users`. `AuthUsersV2`: `AuthUserV2` for the session's own user (a 3.3 client gates this on the reported server version and never sends `AuthUsersV1`).
4. Each line is `{"type": "<entity type>", "data": {...}, "ack": "<entity type>|<row update_id>"}`. The ack is the row's own `update_id`.
5. Emit `{"type": "SyncCompleteV1", "data": {}, "ack": "SyncCompleteV1|<nowId>"}` last.

Trashed assets are not deletes. Setting `deleted_at` bumps the asset's `update_id`, and the asset is emitted as `AssetV2` with `deletedAt` set; the app moves it to its trash view. `AssetDeleteV1` is emitted only after the purge job hard-deletes the row and writes `asset_audit`.

Requested types the server does not implement yet produce no lines; the client tolerates empty sections. A 3.3 client also requests `MemoriesV2`, `AssetMetadataV1`, `AssetEditsV1` and `AssetOcrV1`, among others; these produce no lines in phase 1.

Immich's `needsFullSync` check reads the first 12 hex digits of the `SyncCompleteV1` ack as a timestamp. It is not ported: with these cursors it would force a reset on every stream.

### 6.1 Acks and resets

- `POST /api/sync/ack {acks}`: for each ack, parse `<entity type>|<id>` and upsert the checkpoint for that entity type. `SyncResetV1|reset` instead deletes all of the session's checkpoints and sets `sessions.reset_at = now`, so the next stream is a full resync and does not reset again. Unknown entity types return 400.
- `DELETE /api/sync/ack {types}` removes the checkpoints for those types. The client calls it in pre-sync migrations with types such as `AssetV1`, `PartnerAssetV1` and album asset types, so it accepts every entity type in Immich's enum, implemented or not, and must succeed.
- A session needs a reset when a server migration that changes an entity's shape has recorded a `reset_before` timestamp later than both the session's `reset_at` and its creation.

### 6.2 Limits

Phase 1 request types: `AuthUsersV2`, `UsersV1`, `AssetsV2`, `AssetExifsV1`. The Worker's CPU limit (`limits.cpu_ms`, which applies to the whole Worker) is set to 5 minutes. Upsert passes read entity tables through the `(owner_id, update_id)` index, so a first sync of 100k assets reads 100k asset rows plus 100k EXIF rows, about 400 D1 queries at 500 rows each, under the 1,000-per-invocation limit.

The stream counts its D1 queries and closes normally, without `SyncCompleteV1`, before reaching 950. The client then acks what it received, and the next sync trigger (such as an app resume) continues from the checkpoints. The stream must never end with an error: the client discards unacked buffered lines when the stream throws.

## 7. Upload and processing

### 7.1 `POST /api/assets`

1. Authenticate. Reject with 400 if `Content-Length` would exceed the user's remaining quota. The quota is enforced atomically when the asset row is written.
2. If the request carries `x-immich-checksum` (base64 or hex SHA-1) and it matches an existing asset of the user, return `200 {id, status: "duplicate"}` without reading the body.
3. Stream-parse the multipart body, accepting parts in any order. The mobile app sends text fields first; the web app and `@immich/cli` send some fields (`visibility`, `sidecarData`) after `assetData` and omit `deviceAssetId`, `deviceId` and `filename`. Fields that arrive after the file are buffered (they are small) and applied at the insert in step 5. The file extension comes from the file part's `Content-Disposition` filename. Missing `deviceAssetId`/`deviceId` default to `web`-style values as Immich does.
4. Generate the asset ID (UUIDv4). Stream `assetData` to `originals/<ownerId>/<assetId>.<ext>` via R2 multipart upload in 10 MB parts while computing SHA-1 with `crypto.DigestStream`.
5. Insert the asset (`status = pending`) through `changes`. On a unique `(owner_id, checksum)` conflict, delete the new object and return `200 {id: <existing id>, status: "duplicate"}`.
6. Enqueue `{assetId}` on `asset-process` and return `201 {id, status: "created"}`.
7. On client disconnect, abort the multipart upload.

Supporting endpoints: `POST /api/assets/bulk-upload-check` (checksum list → accept/reject per file, used by the web app and CLI before uploading) and `GET /api/server/media-types` (accepted extensions).

Live photos: the app uploads the video first, then the image with `livePhotoVideoId`. The video is stored with `visibility = hidden`. Uploads validate the requested `visibility` and the live-photo link before writing.

### 7.2 `process` consumer

Each step is idempotent; Queues delivers at least once.

1. **Metadata.** `exifr` on a ranged read of the first 128 KB, extended once if needed. Video metadata (creation date, GPS) is read by the phase 3 `media` container; until then videos use the client's `fileCreatedAt`. Dates fall back to the client's `fileCreatedAt`. GPS-derived timezone and reverse geocoding are deferred to phase 4. The sync stream sends `avatarColor` as null; REST returns Immich's email-derived default.
2. **Thumbnails.** For JPEG, PNG, HEIC, WebP and GIF at 20 MB or less (the Images binding input limit): `preview.jpeg` at 1440 px, `thumbnail.webp` at 250 px, and a 100 px PNG decoded in JS for the thumbhash. Other files get `status = needs_media` for the phase 3 `media` container.
3. **Write** results through `changes`, so clients receive updated `AssetV2` and `AssetExifV1` on the next sync. Set `status = ready` and enqueue `{assetId}` on `asset-backup` (section 8).
4. **Retries.** 5 attempts with backoff, then the dead-letter queue `asset-process-dlq`. Processing sets `status = failed` and `error` only for Images input errors and retries all other errors. A dead-letter handler consumes `asset-process-dlq`, and a daily cron re-enqueues stale `pending` assets. An admin endpoint re-enqueues failed assets.

### 7.3 Media endpoints

`GET /api/assets/{id}/thumbnail?size=thumbnail|preview|fullsize`, `GET /api/assets/{id}/original`, `GET /api/assets/{id}/video/playback`. They stream from R2 with `Range` support. The `edited` and `c` parameters are accepted and ignored. Phase 1 serves video playback from the original file.

- `size=fullsize` (the web app requests it for formats browsers can't show, such as HEIC) is served from `preview.jpeg`, as Immich does when fullsize thumbnails are disabled.
- A thumbnail that does not exist yet returns 404 with `Cache-Control: no-store`. A pending asset has no thumbhash, so the app's URL for it carries no `c` parameter, and a cached placeholder would hide the real thumbnail under that URL.
- Existing thumbnails return `Cache-Control: private, max-age=86400` with an `ETag`. Whatever replaces a thumbnail (such as the phase 3 `media` container) also recomputes the thumbhash, which changes the app's `c` parameter and so its cache key.

## 8. Errors and data safety

- API errors use Immich's shape `{message, error, statusCode, correlationId}`. The correlation ID is the Cloudflare Ray ID.
- Oversized uploads get Cloudflare's edge 413; the app shows its "file too large" message.
- Deletes set `deleted_at` (trash), which syncs as an `AssetV2` update. A daily cron hard-deletes assets trashed more than 30 days ago: it removes the R2 objects, deletes the rows, and writes `asset_audit`.
- Only two code paths delete from `originals/`. The purge job deletes objects of purged assets. The upload path deletes an object it has just written when no asset row references it (duplicate or failed insert).
- D1 Time Travel provides 30 days of point-in-time restore.
- **Backup copy.** A second bucket `immich-originals-backup` receives each original once it is `ready`, via the `asset-backup` queue. The `asset-backup` consumer streams the original from the media bucket into the backup bucket through the R2 bindings; files are at most 100 MB in phase 1, under the 5 GB single-put limit. It then sets `backed_up_at`. A backfill job enqueues every asset with `backed_up_at IS NULL`. Nothing ever deletes from the backup bucket, so a purge bug cannot remove backup copies. A weekly cron re-enqueues any `ready` asset still missing `backed_up_at`.

## 9. Phases

| # | Delivers | Exit check |
|---|---|---|
| 1 | Discovery and server endpoints, auth, upload, sync for own assets, thumbnails and originals, web timeline and asset viewer endpoints, Immich web app hosting, purge cron, backup queue | An iPhone backs up 1,000 photos; they appear in the app and the web timeline |
| 2 | Favourites, archive, trash, albums, second user, partner sharing, shared links, API keys | A family member sees a shared album |
| 3 | `media` container (video posters and metadata, RAW, images over 20 MB) | Every staging video and RAW file shows a thumbnail, duration and capture date |
| 4 | Spike EmbeddingGemma 2 (ONNX or Transformers.js availability, embedding dimension, quality on personal photos); then smart search, faces, map with reverse geocoding | Searching "beach" returns beach photos |
| 5 | Socket.IO push via a Durable Object (deferred from phase 1; the web app shows "Server Offline" until then); memories, tags, stacks | The app refreshes without pull-to-refresh |

Phase 1 endpoints beyond auth, upload, sync and media:

- Discovery and server: `/.well-known/immich`, `/server/ping`, `/server/version`, `/server/version-history` (`[]`), `/server/features`, `/server/config` (`isInitialized`, `isOnboarded: true`), `/server/about`, `/server/storage`, `/server/media-types`.
- User: `/users/me`, `/users/me/preferences`.
- Web timeline and viewer: `/timeline/buckets`, `/timeline/bucket`, `GET /assets/{id}` (full `AssetResponseDto`), plus stubs returning `[]` for `/albums?assetId=`, `/faces?id=` and `/assets/{id}/ocr`.

Feature flags report disabled for features not built yet. The exact endpoint list for the web app is taken from a HAR capture of the Immich 3.3.0 web app against a real server, recorded as the first phase 1 task.

The mobile app opens a Socket.IO connection and only logs failures, so it is left out until phase 5.

## 10. Testing

- **Unit and integration:** Vitest with `@cloudflare/vitest-pool-workers` (D1, R2 and Queues through Miniflare).
- **Contract:** every response in tests is validated against an in-repo validator over the pinned OpenAPI spec. A missing required field fails CI. This guards against the mobile app's generated Dart models rejecting a response.
- **Golden sync:** a fixture library loaded into a real Immich 3.3.0 server (Docker on a Linux x86_64 host) and into the Worker. `/sync/stream` output is compared line by line after normalising IDs and timestamps.
- **End-to-end:** `@immich/cli upload` against `wrangler dev` in CI.
- **Manual phase check:** the Immich iOS app against a staging deployment.

## 11. Cost (monthly, 500 GB, 1–2 users)

| Item | Cost |
|---|---|
| Workers Paid | $5 |
| R2 primary | ~$7.50 |
| R2 backup | ~$7.50 |
| D1, Queues | Within Workers Paid allowances |
| Images | ~$1 ongoing; ~$50–100 one-off for a 100k-photo first import |
| Containers (phases 3–4) | A few dollars, mostly during backfill |
| Fly ingest (backlog) | ~$3 |
| Total | ~$20–25 |

## 12. Risks and open items

| Risk | Mitigation |
|---|---|
| Generated Dart models may throw on missing required fields | Contract tests treat every required field as mandatory |
| The Immich app auto-updates and may need new endpoints or sync types | Pin the compatibility target; track Immich releases; the golden sync test runs against each new tag before upgrading the reported version |
| HEVC/MOV posters through Media Transformations are untested by Cloudflare | Phase 3 uses ffmpeg in the `media` container |
| EmbeddingGemma 2 is days old; runtime support in ONNX or Transformers.js is unknown | Phase 4 starts with a spike |
| Streaming multipart parsing within 128 MB Worker memory | Parse incrementally and never buffer the file; R2 parts of 10 MB |
| Images binding input limit of 20 MB | Larger images go to the `media` container |
