# Phase 2 stream D: partners, system and user config, notifications

Reference behaviour: Immich `partner.service.ts`, `partner.repository.ts`, `sync.service.ts`, `sync.repository.ts`, `utils/access.ts`, `system-config.service.ts`, `utils/config.ts`, `notification.service.ts`, `notification-admin.service.ts`, `notification.repository.ts`, `timeline.service.ts`.

## Tables (migrations 0040–0042)

- `0040_partners.sql`
  - `partners (shared_by_id, shared_with_id, in_timeline, created_at, updated_at, create_id, update_id)`, primary key `(shared_by_id, shared_with_id)`. `in_timeline` defaults to 0 as in Immich. `create_id` is the cursor of the inserting statement (Immich's `createId`, a UUIDv7 set once); it orders partners for backfill. Indexes on `(shared_with_id, create_id)`, `(shared_by_id)` and `(update_id)`.
  - `partner_audit (id, shared_by_id, shared_with_id, deleted_at)`, written with `tracked` in the same commit as the hard delete.
- `0041_system_config.sql`: `system_config (id = 1, value, updated_at)`. `value` holds the JSON diff from the defaults, as Immich's `system_metadata` row does.
- `0042_notifications.sql`: `notifications (id, user_id, level, type, title, description, data, read_at, created_at, updated_at, deleted_at)`. Notifications are not synced, so they have no `update_id`.

## Endpoints

### Partners (`src/partners/routes.ts`)
- `GET /partners?direction=shared-by|shared-with`: direction required (400 otherwise). Partners whose two users are both not deleted. `shared-by` returns the users I share with; `shared-with` returns the users sharing with me. Each is a `UserResponseDto` plus `inTimeline`.
- `POST /partners {sharedWithId}` and deprecated `POST /partners/{id}`: 400 `Partner already exists`, 400 `Invalid user` for a missing or deleted user. 201 with the shared-with user.
- `PUT /partners/{id} {inTimeline}`: `id` is the sharer; the caller must be the shared-with side, otherwise 400 `Not found or no partner.update access`. Returns the sharer.
- `DELETE /partners/{id}`: removes the partner where the caller shares with `id`; 400 `Partner not found`; 204.

### Partner access
- `src/access/partners.ts` exports `partnerCanReadAsset(db, userId, assetId)` (Immich `AssetAccess.checkPartnerAccess`: the sharer is not deleted, the asset is not trashed, visibility `timeline` or `hidden`). `loadOwnedAsset` admits owner OR partner. All its callers are reads (`GET /assets/{id}`, thumbnail, original, video playback).
- Timeline (`/timeline/buckets`, `/timeline/bucket`):
  - `userId` other than the caller needs a partner row (Immich `TimelineRead`), else 400. An archive timeline of another user is refused (`ArchiveRead` is owner only).
  - `withPartners=true` adds sharers with `in_timeline = 1` whose user is not deleted. As Immich, it is refused (400) unless `visibility` is given and is not `archive` or `locked`, `isFavorite` is absent and `isTrashed` is not true.
  - `isFavorite` in a bucket is true only for the caller's own assets.

### Partner sync (`src/sync/passes/partners.ts`), in Immich `SYNC_TYPES_ORDER`
- `PartnersV1`: `PartnerDeleteV1` (audit rows where I am either side), then `PartnerV1` (partners where I am either side).
- `PartnerAssetsV2`: `PartnerAssetDeleteV1` (asset audit of my sharers), then `PartnerAssetBackfillV2`, then `PartnerAssetV2` (`isFavorite` always false, as Immich).
- `PartnerAssetExifsV1`: `PartnerAssetExifBackfillV1`, then `PartnerAssetExifV1`.
- `PartnerStacksV1`: emits nothing (stacks do not exist yet).
- Backfill follows `sync.service.ts`. Partners are ordered by `create_id`. With no upsert checkpoint the client gets everything through the upsert pass, so the server writes `<Backfill>|<last createId>|complete` itself and sends nothing. With an upsert checkpoint, each partner not yet complete gets its rows with `update_id <= upsert checkpoint`. Each row's ack is `<Backfill>|<createId>|<updateId>`, and the partner ends with a `SyncAckV1` line whose ack is `<Backfill>|<createId>|complete`.
- Shared sync changes, each marked `// stream D`:
  - `acks.ts` accepts the 3-segment form for backfill entity types only.
  - `Pass.fetch` gets an optional context (checkpoints, session id). A row can carry `type` to emit a `SyncAckV1` line. `Pass.queriesPerFetch` keeps the query budget exact for passes that run two queries per page.

### Config (`src/config/*`)
- `GET /system-config`, `GET /admin/config`: stored diff merged over `src/defaults/system-config.json`.
- `PUT /system-config`, `PUT /admin/config` (admin): the body is validated against `AdminConfigDto` from the pinned spec (types, required fields, enums, patterns, min/max, `minItems`, `uri` format); unknown keys are dropped as zod does. Invalid input gets 400. The diff from the defaults is stored, and the merged config is returned.
  - Immich's `ConfigValidate` SMTP check runs too. Enabling SMTP, or changing the SMTP settings while SMTP is enabled, needs a transport verification, and this server cannot verify one, so it returns 400 `Invalid SMTP configuration`.
- `GET /admin/config/defaults`, `GET /system-config/defaults`: the defaults.
- `GET /config`, `GET /config/defaults` (any user): the config projected onto `UserConfigDto`.
- Readers of the stored config:
  - `GET /server/config`: `loginPageMessage`, `trashDays`, `userDeleteDelay`, `oauthButtonText`, `externalDomain`, `publicUsers`, map style URLs, `minFaces`.
  - `GET /public/config`: `loginPageMessage`, `customCss`, OAuth `buttonText`. OAuth stays disabled and password login enabled because this server implements only password login.
  - `/server/features` still reports server capabilities. It does not report config flags, because enabling e.g. trash or map in the config does not make the feature exist.

### Notifications (`src/notifications/routes.ts`)
- `GET /notifications?id&level&type&unread`: the caller's live notifications, newest first. Bad uuid or enum gives 400.
- `PUT /notifications {ids, readAt}` and `DELETE /notifications {ids}`: every id must belong to the caller, else 400 `Not found or no notification.<x> access`. Delete is soft (`deleted_at`). 204.
- `GET`, `PUT`, `DELETE /notifications/{id}`: same access rule.
- `POST /admin/notifications`: admin creates for `userId`; `type` defaults to `Custom`, `level` to `info`; 201.
- `POST /admin/notifications/templates/{name} {template}`: returns `{name, html}`. Immich renders React email components. This server renders the custom template (or the stored one) with Immich's `{tag}` replacement, and uses a short built-in HTML body when no template is set. Unknown names give an empty `html`, as Immich.
- `POST /admin/notifications/test-email`: validates the `AdminConfigSmtpDto` body, then returns Immich's SMTP verification failure, 400 `Failed to verify SMTP configuration`. This server does not send email in phase 2.

## Deviations from Immich
- `GET /notifications/{id}` returns live notifications. Immich's repository filters `deletedAt IS NOT NULL` there (a bug), so live notifications 400 in Immich.
- Creating a partner with yourself is refused with 400 `Invalid user`. Immich allows it, and that would sync your own assets back to you as partner assets.
- Updating a notification that was soft-deleted returns 400 `Notification not found` (Immich throws a 500 from `executeTakeFirstOrThrow`).
- `POST /admin/notifications` with an unknown `userId` returns 400 `User not found` (Immich fails on the foreign key).

## Deferred
- Email sending and the SMTP verification: no SMTP from Workers in phase 2.
- Notification cleanup job (Immich's `NotificationsCleanup`): rows are small and soft-deleted. The cron module belongs to another stream, so the cleanup can be added there.
- Notifications created by server events (job failures, album invites): no event source exists yet.
- `PartnerStacksV1` backfill and upserts: stacks do not exist yet; the pass emits nothing.
- Partner rows when a user is hard-deleted: users are never hard-deleted yet. Whoever adds user purge must delete that user's partner rows with `partner_audit` entries.
