# Phase 2 stream E: tags and stacks

## Tables (migration `0050_tags_stacks.sql`)

- `tags (id, user_id, value, color, parent_id, created_at, updated_at)`, unique `(user_id, value)`. `parent_id` references `tags` with `ON DELETE CASCADE`. Not synced (Immich 3.3 has no tag sync type), so no `update_id`.
- `tag_asset (tag_id, asset_id)`, both FKs cascade. Descendant lookups use a recursive CTE over `parent_id` instead of Immich's `tag_closure` table.
- `assets.stack_id TEXT` (synced field, written through `tracked`, one asset per statement).
- `stacks (id, owner_id, primary_asset_id UNIQUE, created_at, updated_at, update_id)`. `primary_asset_id` has no FK so purge of a primary asset cannot fail; `src/stacks/repo.ts` exports `releaseAssetsFromStacks` for the asset delete path.
- `stack_audit (id, stack_id, owner_id, deleted_at)`, written with `tracked` like `asset_audit`.

## Endpoints

Tags: `GET/POST/PUT /tags`, `PUT /tags/assets`, `GET/PUT/DELETE /tags/{id}`, `PUT/DELETE /tags/{id}/assets`.
Stacks: `GET/POST/DELETE /stacks`, `GET/PUT/DELETE /stacks/{id}`, `DELETE /stacks/{id}/assets/{assetId}`.

## Immich behaviours matched

- Access failures on tag/stack/asset ids are `400 "Not found or no <permission> access"` (Immich `requireAccess`), ownership only.
- Tag create: `value = parent.value/name`, duplicate value is 400. Update renames the last path segment and rewrites descendant values. Upsert creates each path segment, returns the leaf per input. Name must not contain `/`. Colour is normalised to a leading `#`.
- Tag/untag by id returns `BulkIdResponseDto[]` (`duplicate`, `no_permission`, `not_found`). Bulk tagging returns `{count}` of inserted pairs.
- Stack create: first id becomes primary; existing stacks whose primary is among the ids are dissolved and their (non-trashed) children join the new stack. Min 2 ids. Stack responses list non-trashed timeline/archive assets, primary first, then by `file_created_at`.
- Stack update: primary must be in the stack. Remove asset: must be in the stack and not primary. Delete (single and bulk) clears `stack_id` on every member.
- Sync: `StacksV1` after `AssetsV2` (`StackDeleteV1`, then `StackV1`). `AssetV2.stackId` carries `assets.stack_id`.
- Timeline: `tagId` matches the tag and its descendants. `withStacked` hides non-primary stack members and fills `stack` as `[stackId, count]` (count of non-trashed timeline-visibility members), `null` for unstacked assets.
- `GET /assets/{id}` additionally returns `tags` and `stack` (Immich includes both).

## Deferred or different

- `asset_exif.tags` and sidecar writes (Immich `updateTags`, `SidecarWrite`) do not exist here.
- The `TagCleanup` job (empty tag purge) is not run.
- Tag and stack access for shared-link and partner auth does not exist yet (ownership only).
