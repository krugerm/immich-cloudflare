# Phase 2 stream A: users and auth

Scope: the 42 endpoints in `phase2-A-endpoints.md` (users, admin users, authentication, PIN codes, sessions, API keys, OAuth stubs). Reference behaviour is Immich 3.3 (`user.service.ts`, `user-admin.service.ts`, `auth.service.ts`, `session.service.ts`, `api-key.service.ts`, `auth-admin.service.ts`).

## Migration `0010_users_auth.sql`

`users` gains `should_change_password` (0), `pin_code` (PBKDF2 hash or NULL), `profile_image_path` (R2 key or ''), `status` (`active`/`removing`/`deleted`) and `license` (JSON or NULL).

`sessions` gains `pin_expires_at`, `expires_at`, `parent_id` (child sessions from `POST /sessions`, deleted with the parent) and `is_pending_sync_reset` (0/1).

New table `api_keys (id, user_id → users ON DELETE CASCADE, name, key_sha256 UNIQUE, permissions JSON array, created_at, updated_at)`. It is not synced and gets no audit table.

## Request validation

`src/http/validate.ts` validates JSON bodies against the request schemas in `vendor/immich-openapi.json` (type, required, nullable, enum, pattern, format, minimum/maximum, minLength, minItems). Unknown keys are dropped, as zod does in Immich. Bad input returns 400.

## Authentication changes (`src/auth/session.ts`)

- Token order stays as in phase 1. When no session token is present, `x-api-key` (or `?apiKey=`) is looked up by SHA-256 in `api_keys`, as Immich does. A present but unknown session token still returns 401 `Invalid user token`; an unknown key returns 401 `Invalid API key`.
- API-key requests carry `auth.apiKey`. `auth.session` is then a placeholder whose id `api-key:<uuid>` matches no `sessions` row, so session-keyed reads find nothing and session-keyed writes are refused by the foreign key.
- Each route's required permission comes from the operation's `x-immich-permission` in the OpenAPI file, looked up by `c.req.routePath`. Routes without one need `all`, except `POST /auth/validateToken` and `GET /api-keys/me` (Immich's `permission: false`). A key lacking the permission gets 403 `Missing required permission: <p>`.
- `/sync/*` routes return 403 `Sync endpoints cannot be used with API keys`.
- Sessions with `expires_at` in the past are rejected. `pin_expires_at` in the future makes the session elevated (`auth.hasElevatedPermission`), and Immich's 5-minute sliding extension is applied.

## Endpoints

Users (self): `PUT /users/me` (email uniqueness → 400 `Email is not available`; name; avatarColor), `PUT /users/me/preferences` (merged into the stored partial; only keys that differ from the defaults are stored, as Immich's `getPreferencesPartial`), license get/set/delete (format checked by the DTO pattern; signatures are not verified), onboarding get/set/delete (backed by `is_onboarded`), profile image upload/get/delete, `GET /users/{id}`.

Users (admin): create, update (self-demotion → 400, email and storage-label uniqueness → 400, password and PIN hashed), soft delete (`force` sets `status = removing`, otherwise `deleted`; deleting yourself → 403), restore, `PUT /admin/users/{id}/preferences`.

Auth: change password (current password check, then all other sessions are deleted; Immich 3.3's listener ignores `invalidateSessions` and always does this), PIN setup/change/reset (6 digits, PBKDF2 like passwords; reset locks all sessions), session lock/unlock (unlock sets `pin_expires_at` to now + 15 min), `GET /auth/status`.

Sessions: create a child session (session token required, optional `duration`), delete one, delete all others, update `isPendingSyncReset`, lock one. Ownership failures return 400 `Not found or no <permission> access`, as Immich's `requireAccess`.

API keys: list, create (plaintext `secret` returned once; a key cannot grant permissions it lacks), get, `GET /api-keys/me`, update, rotate, delete.

OAuth: `server/features.oauth` is false, so authorize, callback and link return 400 `OAuth is not enabled`, backchannel logout returns Immich's disabled-OAuth 400, unlink returns the user unchanged, `GET /oauth/mobile-redirect` redirects to `app.immich:///oauth-callback`, and `POST /admin/auth/unlink-all` is a no-op 204 because no user carries an OAuth id. OAuth login itself is deferred.

## Sync

User writes go through `tracked`, one row per statement, so `UserV1` and `AuthUserV2` pick up name, email, avatar colour, profile image (`hasProfileImage`), `profileChangedAt`, `deletedAt`, quota, storage label and `pinCode` (the stored hash, as Immich sends it). `isPendingSyncReset` set through `PUT /sessions/{id}` makes the next stream emit only `SyncResetV1`; a reset clears it (`src/sync/acks.ts`).

## User deletion

Soft delete sets `deleted_at` (sync emits `UserV1` with `deletedAt`); sessions and API keys of a deleted user stop authenticating. A daily cron step (`src/cron/purge-users.ts`) hard-deletes users with `status = removing` or deleted more than 7 days ago (Immich's default `user.deleteDelay`): their assets in batches (R2 objects, `asset_audit` rows), the profile image, then the user row with a `user_audit` row (`UserDeleteV1`). Sessions, checkpoints and API keys go by cascade.

## Hardening (fix round 1)

- PIN checks (unlock, change, reset) count attempts per user in `login_failures` with the row id `pin:<userId>`. After 5 failures within 15 minutes every check returns 429 before verifying; a success clears the counter. Immich has no such limit.
- Login counters use the row id `login:<email>` (fix round 2), so a login attempt can never address a PIN counter; login emails without `@` return 400 before any counting. Migration `0011_lockout_keys.sql` deletes the old un-prefixed rows (they expire after 15 minutes anyway).
- Both lockouts reserve the attempt before verifying (`src/auth/lockout.ts`): one upsert increments the counter, restarts it when the window has expired and returns the new count, and a count over the limit gets 429 unverified. Concurrent guesses therefore cannot pass the limit.
- `AuthUserV2.pinCode` carries the stored PIN hash, as Immich's sync protocol defines it, so anyone holding one of the user's session tokens can read the hash and brute-force the 6-digit PIN offline. The PIN gates the locked folder only; the server-side lockout does not cover this path.
- Profile image uploads are parsed with the streaming multipart parser (`src/upload/multipart.ts`). The body is cut off after 10 MB plus 64 KB and the file part after 10 MB, so a chunked body without `Content-Length` is never buffered past the cap. A declared `Content-Length` over the cap is rejected before reading.
- Profile images are served with `x-content-type-options: nosniff` and `cache-control: private, no-cache, no-transform` (Immich sends no cache header). EXIF metadata, GPS included, is not stripped from uploaded profile images; re-encoding needs an image library and is deferred.
- The daily cron deletes sessions whose `expires_at` has passed, and the user purge continues with the next user when one fails.
- `POST /sessions` with a `duration` beyond the largest representable date returns 400.

## Deviations and deferrals

- `PUT /users/me` rejects `password` with 400; password changes go through `POST /auth/change-password`, which checks the current password. Immich accepts the deprecated field without a check.
- Profile images are stored as uploaded (JPEG, PNG, WebP, GIF or HEIC, at most 10 MB) at `profile/<userId>.<ext>`; Immich re-encodes them to a 250 px thumbnail.
- `force` delete runs at the next daily cron, where Immich queues the job at once.
- New users get `is_onboarded = 1`, as the phase 1 admin does, so the web app skips its onboarding flow.
- Album soft delete and restore on user delete belong to the albums stream.
- OAuth login, linking and claim sync are deferred until an OAuth provider is configured.
