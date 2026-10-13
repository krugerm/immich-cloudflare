# Phase 2, stream C: albums, shared links, activities

Reference: Immich 3.3.0-rc.0 (`album.service.ts`, `shared-link.service.ts`, `activity.service.ts`, `utils/access.ts`, `access.repository.ts`, `sync.service.ts`, `sync.repository.ts`, `schema/functions.ts`).

## Tables (migrations 0030–0032)

| Table | Columns | Notes |
|---|---|---|
| `albums` | `id`, `name`, `description` (null shown as `''`), `thumbnail_asset_id` (no FK), `asset_order` (`asc`/`desc`), `is_activity_enabled`, `created_at`, `updated_at`, `update_id` | Synced (`AlbumV2`). No owner column: like Immich 3.3 the owner is the `album_users` row with role `owner` |
| `album_users` | `album_id`, `user_id`, `role` (`owner`/`editor`/`viewer`), `create_id`, `created_at`, `updated_at`, `update_id` | Synced (`AlbumUserV1`). `create_id` is the cursor at insert and drives backfill |
| `album_assets` | `album_id`, `asset_id` (FK `assets` ON DELETE CASCADE), `created_at`, `update_id` | Synced (`AlbumToAssetV1`, `AlbumAssetCreateV2`, `AlbumAssetExifCreateV1`) |
| `album_audit` | `id` (cursor), `album_id`, `user_id`, `deleted_at` | One row per member whenever a member row goes away (user removed or album deleted) → `AlbumDeleteV1` for that user |
| `album_user_audit` | same | Only when a user is removed from an album that still exists → `AlbumUserDeleteV1` for the remaining members |
| `album_asset_audit` | `id`, `album_id` (FK albums ON DELETE CASCADE), `asset_id`, `deleted_at` | Asset removed from an album → `AlbumToAssetDeleteV1` |
| `shared_links` | `id`, `user_id`, `key` (unique, base64url), `slug` (unique), `type` (`ALBUM`/`INDIVIDUAL`), `album_id` (FK CASCADE), `description`, `password_hash`, `expires_at`, `allow_upload`, `allow_download`, `show_metadata`, `created_at` | Not synced |
| `shared_link_assets` | `shared_link_id`, `asset_id` (both FK CASCADE) | |
| `activities` | `id`, `album_id`, `user_id`, `asset_id`, `comment`, `is_liked`, `created_at`, `updated_at` | FK `(album_id, asset_id)` → `album_assets` ON DELETE CASCADE as in Immich; one like per (album, asset, user) |

Indexes added on phase 1 tables: `assets(update_id)` and `asset_exif(update_id)`, used by the album asset update passes, which scan assets of other owners.

Writes follow the phase 1 rule: every synced row (albums, album_users, album_assets and the audit rows) is written by one `tracked()` statement and committed with `commit()`. Immich's triggers are reproduced explicitly:
- adding a non-owner member bumps the album's `update_id` (`album_user_after_insert`), so the new member receives `AlbumV2`;
- removing a member writes `album_audit` + `album_user_audit`; deleting an album writes one `album_audit` per member (`album_user_delete_audit`);
- removing assets writes `album_asset_audit` (`album_asset_delete_audit`); deleting an album does not.

Album thumbnails: Immich repairs them lazily (`updateThumbnails`) on `GET /albums` and `GET /albums/:id`. This port does the same, one tracked update per album that needs it (thumbnail missing while the album has non-trashed assets, or pointing at an asset no longer in the album or trashed).

## Access (`src/access/assets.ts`)

- `canReadAsset(db, userId, assetId)`: owner, or member (any role) of an album that contains the asset (or its live-photo still) while the asset is not trashed. Each rule is one SQL line in `READ_RULES`; stream D adds the partner rule there.
- `shareableAssetIds(db, userId, ids)`: Immich `AssetShare` = owner (partner rule added by stream D in `SHARE_RULES`).
- `loadOwnedAsset` in `src/media/routes.ts` keeps its name and signature and now means "readable by the caller": shared-link callers go through the link's asset set, users through `canReadAsset`.
- Album permissions follow `utils/access.ts`: read = any member; add/remove assets, update, share = owner or editor; delete = owner. Denied or missing albums answer 400 `Not found or no album.<perm> access` like `requireAccess`.

## Endpoints

Albums: `GET/POST /albums`, `GET /albums/statistics`, `PUT /albums/assets`, `GET/PATCH/DELETE /albums/:id`, `PUT/DELETE /albums/:id/assets`, `PUT /albums/:id/users`, `PUT/DELETE /albums/:id/user/:userId` (`me` accepted on delete), `GET /albums/:id/map-markers`. Timeline: `albumId` returns the album's assets (all owners) when the caller can read the album.

Shared links: `GET/POST /shared-links`, `GET/PATCH/DELETE /shared-links/:id`, `PUT/DELETE /shared-links/:id/assets`, `GET /shared-links/me`, `POST /shared-links/login`.

Activities: `GET/POST /activities`, `GET /activities/statistics`, `DELETE /activities/:id`. `POST` answers 201 for a new row and 200 with the existing like for a duplicate like.

## Shared-link authentication

Order as in Immich `AuthService.validate`: `x-immich-share-key` header or `?key=`, then `x-immich-share-slug` or `?slug=`, then the session. A link is valid while its owner exists and `expires_at` is unset or in the future; otherwise 401 `Invalid share key` / `Invalid share slug`. A shared-link caller reaches only: `GET /shared-links/me`, `POST /shared-links/login`, `GET /albums/:id`, `GET /albums/:id/map-markers`, `GET /assets/:id`, the thumbnail/original/playback media routes and the timeline with `albumId`. Original downloads need `allowDownload`. `showMetadata = false` strips EXIF and map markers.

Share keys: 50 random bytes, stored and returned as unpadded base64url in every response, as in Immich. Lookup canonicalises the incoming key (100-character hex or base64url), finds it by indexed equality and confirms it with a constant-time compare.

Locked assets: Immich `AssetShare` excludes them, so they cannot be added to albums or links. Immich also removes an asset from all albums when it is locked (`AssetService` → `AlbumRepository.removeAssetsFromAll`, audited, so members get `AlbumToAssetDeleteV1`). `removeAssetFromAllAlbums(db, ownerId, assetId)` in `src/albums/repo.ts` provides those statements for stream B's visibility update at merge. As a second guard, shared links, album timelines (other owners), sync, map markers, thumbnails and activities skip locked assets.

Passwords: stored as a PBKDF2 hash (same format as user passwords). `POST /shared-links/login` checks it and sets the `immich_shared_link_token` cookie (comma-joined list, 1 day) with `base64(sha256("<id>-<password_hash>"))`. Responses report `password` as an opaque marker when one is set, and `PATCH` with that marker leaves the password unchanged. Unlike Immich, the token is required for every shared-link read (media, asset, album, timeline), not only `/shared-links/me`.

## Sync

Request types, registered in Immich's `SYNC_TYPES_ORDER` position: `AlbumAssetsV2`, `AlbumsV2`, `AlbumUsersV1`, `AlbumToAssetsV1` (before `AssetExifsV1`), `AlbumAssetExifsV1` (after it).

| Request | Passes (in order) |
|---|---|
| `AlbumsV2` | `AlbumDeleteV1` (album_audit for me), `AlbumV2` (albums I am a member of) |
| `AlbumUsersV1` | `AlbumUserDeleteV1`, `AlbumUserBackfillV1`, `AlbumUserV1` |
| `AlbumToAssetsV1` | `AlbumToAssetDeleteV1`, `AlbumToAssetBackfillV1`, `AlbumToAssetV1` |
| `AlbumAssetsV2` | `AlbumAssetBackfillV2`, `AlbumAssetUpdateV2` (only once `AlbumAssetCreateV2` is acked), `SyncAckV1` for `AlbumAssetUpdateV2|<now>` before the first create, `AlbumAssetCreateV2` |
| `AlbumAssetExifsV1` | `AlbumAssetExifBackfillV1`, `AlbumAssetExifUpdateV1`, `SyncAckV1`, `AlbumAssetExifCreateV1` |

Backfill follows `sync.service.ts`: albums are the caller's `album_users` rows ordered by `create_id`. With an upsert checkpoint, each album not yet complete is backfilled for rows with `update_id <= checkpoint` (after the stored progress id), each line acked `<type>|<createId>|<updateId>`, closed by a `SyncAckV1` line acked `<type>|<createId>|complete`. Without an upsert checkpoint the server stores `<type>|<lastCreateId>|complete` itself. `isFavorite` in album asset lines is the asset's value only for the caller's own assets.

Shared-module changes: `src/sync/acks.ts` accepts `<type>|<cursor>|<cursor or complete>` for entity types whose name contains `Backfill` and stores the third segment; `getCheckpointAcks` returns both ids. `src/sync/routes.ts` runs a second pass kind (`StreamPass`) that yields whole lines and shares the stream's query budget.

## Deviations and deferrals

- Shared-link upload (`allowUpload` into an album) and download archives are not part of this stream.
- No `AlbumInvite`/`AlbumUpdate` notifications or emails (no notification system yet).
- `AlbumsV1` and `AlbumAssetsV1` (deprecated; a 3.3 client sends the V2 types) produce no lines.
- Album thumbnails pointing at purged assets are repaired on the next REST album read. The purge job does not touch albums.
