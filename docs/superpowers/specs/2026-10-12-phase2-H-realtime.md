# Phase 2 stream H: realtime Socket.IO events

## Goal
The stock Immich web app shows "Server Offline" while its Socket.IO connection is down, and both apps refresh the timeline on websocket events. This stream serves `/api/socket.io` and gives other code one function to push events to a user's open clients.

## Client facts (Immich 3.3)
- Web (`web/src/lib/stores/websocket.ts`): `io({ path: '/api/socket.io', transports: ['websocket'] })`, cookie auth (`immich_access_token`). Listens to `on_upload_success`, `on_asset_delete`, `on_asset_trash`, `on_asset_update`, `on_person_thumbnail`, `on_server_version`, `on_new_release`, `on_session_delete`, `on_user_delete`, `on_notification`, `AppRestartV1`, `MaintenanceStatusV1`, `AssetEditReadyV2`.
- Mobile (`mobile/lib/providers/websocket.provider.dart`): `setPath('<endpoint path>/socket.io')`, `setTransports(['websocket'])`, its WebSocket connector (`NetworkRepository.createWebSocket`) goes through the native HTTP stack (`HttpClientManager.kt` on Android, `URLSessionManager.swift` on iOS), which authenticates with the `immich_access_token` cookie from the native cookie jar and sends no `Origin` header. Listens to `AssetUploadReadyV1/V2`, `AssetEditReadyV1/V2`, `on_album_update`, `on_asset_stack_update`, `on_asset_delete|trash|restore|hidden|update`, `on_config_update`, `on_new_release`.
- Both use WebSocket only, so no long-polling transport is needed. A polling request gets Engine.IO's `400 {"code":0,"message":"Transport unknown"}`.
- Immich server (`websocket.repository.ts`): each socket joins room `<userId>` and room `<sessionId>`; on connect it sends `on_server_version` to the user (`version.service.ts`). Upload processing sends `on_upload_success` (AssetResponseDto) and `AssetUploadReadyV2` (`{asset: SyncAssetV2, exif: SyncAssetExifV1}`), for timeline/archive assets only. `on_session_delete` goes to the session room.

## Design
- Durable Object `RealtimeHub` (SQLite class, migration tag `v1-realtime-hub`), one per user (`idFromName(userId)`), binding `REALTIME`. It holds WebSockets with the Hibernation API. Each socket's attachment stores `{sid, sessionId, connected, lastSeen}`.
- Worker route `GET /api/socket.io` and `/api/socket.io/*` (`src/realtime/routes.ts`): requires `EIO=4` and `transport=websocket` plus an `Upgrade: websocket` header. Auth uses `extractToken` + `findSession` (the same lookup order as `requireAuth`). A valid session forwards the upgrade to the user's DO with the session id.
- Unauthenticated upgrade: mirrors Immich, which accepts the transport and then refuses the namespace. The Worker accepts a WebSocketPair, sends the Engine.IO open packet and `44{"message":"unauthorized"}` (Socket.IO CONNECT_ERROR), then closes. socket.io-client treats CONNECT_ERROR as final and does not loop on reconnects. Non-upgrade requests get 400.
- Wire protocol in the DO: on accept send `0{"sid","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}`. Client `40` (optionally `40{auth}`) for namespace `/` gets `40{"sid"}` and then `42["on_server_version",{major,minor,patch,prerelease:null}]`. Other namespaces get `44/<nsp>,{"message":"Invalid namespace"}`. `41` and Engine.IO `1` close the socket. `3` (pong) updates `lastSeen`. A client `2` gets `3`. Client events (`42…`) are ignored.
- Heartbeat: a DO alarm every 25 s sends `2` to every socket and closes sockets silent for longer than pingInterval + pingTimeout. The alarm is not re-armed once no sockets remain. Hibernation auto-response does not fit, because Engine.IO v4 pings come from the server.
- Emit API (`src/realtime/emit.ts`, stable for other streams):
  - `emit(env, userId, event, ...args)` sends `42["event",...args]` to the user's namespace-connected sockets.
  - `emitToSession(env, userId, sessionId, event, ...args)` sends to the sockets of one session (Immich's session room).
  - `broadcast(env, event, ...args)` sends to every non-deleted user.
  - `emitUploadReady(env, assetId)` and `emitAssetsDeleted(env, assets)` are the phase-1 wiring helpers.
  - Event names and payloads are typed by `ClientEventMap`, copied from Immich. All functions catch and log errors and never throw.
- Wiring (one line each): `processAsset` calls `emitUploadReady` after the commit that ends in `ready` or `needs_media` (both are visible in the timeline). `purgeAssets` calls `emitAssetsDeleted` after its commit, which sends `on_asset_delete` per asset to its owner.

## Security
- Session revocation: sockets are tagged with their session id. `disconnectSession(env, userId, sessionId)` sends `on_session_delete` and `41` to that session's sockets and closes them; `disconnectUser(env, userId)` closes all of a user's sockets. Logout calls `disconnectSession`. Stream A's session-delete endpoints (`DELETE /sessions/:id`, `DELETE /sessions`, password change, user delete) must call these too. The hub does not re-check the session in D1 on each emit (one query per wake per socket); revocation relies on these hooks.
- Cross-site WebSocket hijacking: when the cookie is the credential (no token header, `sessionKey` or non-empty bearer), an `Origin` header must equal the request's own origin, else 403. A cookie upgrade without `Origin` is the mobile app's native cookie-jar connection and is accepted. Token auth (header, `sessionKey`, bearer) is unaffected.

## Deviations and deferrals
- The checklist names `AssetUploadReadyV1`. Immich 3.3 sends `AssetUploadReadyV2` (SyncAssetV2 + SyncAssetExifV1), which matches the sync stream phase 1 serves (`AssetsV2`), so only V2 is sent.
- `on_asset_trash`, `on_asset_restore`, `on_asset_update`, `on_asset_hidden`, `on_person_thumbnail`, `on_session_delete`, `on_config_update`, `on_new_release`, `on_user_delete`, `on_album_update`, `on_notification` are typed and deliverable through `emit`/`emitToSession`/`broadcast`; the endpoints that cause them belong to other streams, which add the calls.
- No migrations, no tables (range 0080–0089 unused). No server features flag changes (Immich gates nothing on websockets).
- Shared-link and API-key auth on the socket are not supported, matching phase-1 `requireAuth`.
