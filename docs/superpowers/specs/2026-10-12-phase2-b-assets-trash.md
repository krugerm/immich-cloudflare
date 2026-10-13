# Phase 2 stream B: asset edits, trash, download, asset metadata

Branch `phase2-b`. Migration range `0020`-`0029`. Reference: Immich `asset.service.ts`, `trash.service.ts`, `download.service.ts`.

## Migration 0020

- `asset_exif.locked_properties TEXT` (JSON array of `dateTimeOriginal`, `timeZone`, `latitude`, `longitude`, `rating`, `description`). Immich locks columns the user edited so a later metadata extraction does not overwrite them. The phase 1 process consumer's exif upsert now keeps locked columns, and its `local_date_time` write is skipped while `dateTimeOriginal` is locked. Not part of any sync payload.
- `asset_metadata (asset_id, key, owner_id, value TEXT JSON, created_at, updated_at, update_id)`, primary key `(asset_id, key)`, `ON DELETE CASCADE` from `assets`, index `(owner_id, update_id)`.
- `asset_metadata_audit (id, asset_id, key, owner_id, deleted_at)`, one row per explicit key delete (written with `tracked`). Hard-deleting an asset cascades its metadata; the client drops it on `AssetDeleteV1`.

## Endpoints

Access: every endpoint authenticates with `requireAuth`. `requireAssetAccess` (`src/assets/access.ts`) checks ownership of every id and throws 400 `Not found or no asset.<permission> access`, which is what Immich's `requireAccess` returns. Albums, partners and shared links extend that single function later.

| Group | Endpoints | Behaviour |
|---|---|---|
| Update | `PUT /assets/{id}`, `PUT /assets` | `isFavorite`, `visibility`, `description`, `dateTimeOriginal`, `latitude`, `longitude`, `rating`; bulk also `dateTimeRelative`, `timeZone`, `duplicateId` (accepted, ignored: no duplicate detection until phase 4). Exif columns edited are added to `locked_properties`. `dateTimeOriginal` with an offset sets `time_zone` as Immich does (`UTC+2`) and `assets.local_date_time` is recomputed. One tracked statement per row per asset. `visibility: locked`, or leaving `locked`, is 403 until stream A's PIN session exists. `livePhotoVideoId` link/unlink follows `onBeforeLink`/`onAfterUnlink`. |
| Delete | `DELETE /assets` | Sets `deleted_at` (tracked, per asset). `force: true` trashes then runs `purgeAssets`, in batches of 25. |
| Trash | `POST /trash/restore/assets`, `POST /trash/restore`, `POST /trash/empty` | Restore clears `deleted_at`. Empty purges the user's trash through `purgeAssets`, at most 200 assets per request (subrequest budget); the response `count` is the number purged. |
| Download | `POST /download/info`, `POST /download/archive` | `info` groups assets (`assetIds` or the user's whole timeline via `userId`; `albumId` is 400 until albums exist) into archives of `archiveSize` (default 4 GiB) and adds live-photo videos. `archive` streams a STORE-method ZIP with data descriptors straight from R2. Accepts JSON or form bodies (`assetIds` as a comma-separated string). |
| Jobs | `POST /assets/jobs` | `refresh-metadata` and `regenerate-thumbnail` reset the asset to `pending` (tracked) and enqueue processing. `refresh-faces` and `transcode-video` are accepted and do nothing (phase 3/4). |
| Copy | `PUT /assets/copy` | Copies `favorite`. Albums, shared links and stacks do not exist yet; sidecars are not stored. |
| Metadata | `GET/PUT /assets/{id}/metadata`, `GET/DELETE /assets/{id}/metadata/{key}`, `PUT/DELETE /assets/metadata` | Backed by `asset_metadata`. New sync pass `AssetMetadataV1` (`AssetMetadataDeleteV1`, `AssetMetadataV1`). |
| Edits | `GET /assets/{id}/edits`, `DELETE /assets/{id}/edits` | Asset has no edits: GET returns an empty list, DELETE is a no-op. |

## Immich behaviours matched

- Trash does not touch the hidden motion video of a live photo; `purgeAssets` removes a video no other asset references together with its still. Restore needs no video handling.
- Trash restore affects only trashed assets. Restore-all is per user.
- Timeline trash view applies the default visibility filter (`timeline`, `archive`), so hidden videos never show as trash items. This fixes a phase 1 deferral in `src/timeline/routes.ts`.

## Deferred

- `PUT /assets/{id}/edits` (crop/rotate/mirror): needs edited thumbnail and original rendering, which the phase 1 Images pipeline cannot do. Returns 400.
- HLS video streaming (`/assets/{id}/video/stream/*`): needs the phase 3 `media` container.
- `PUT /assets/{id}/original` (replace): not in the stream B checklist.
- Sidecar copy: sidecar files are not stored.
