/**
 * Realtime events to connected Immich clients (Socket.IO `42["event",...args]` frames).
 *
 * Stable API for every stream:
 *   emit(env, userId, event, ...args)                    -> all of the user's sockets (Immich room `<userId>`)
 *   emitToSession(env, userId, sessionId, event, ...args) -> one session's sockets (Immich room `<sessionId>`)
 *   broadcast(env, event, ...args)                        -> every non-deleted user (Immich `clientBroadcast`)
 *   disconnectSession(env, userId, sessionId)             -> required after deleting a session row
 *   disconnectUser(env, userId)                           -> required after deleting a user or all its sessions
 *
 * Event names and argument lists follow Immich's ClientEventMap (server/src/repositories/websocket.repository.ts).
 * None of these functions throw: failures are logged and swallowed so the caller's work never fails on them.
 * Call them after the D1 commit that makes the change visible, so a client that refetches sees it.
 */
import { mapAssetResponse } from '../assets/map';
import type { AssetRow, ExifRow } from '../db/rows';
import type { Dto } from '../gen/dto';
import { mapSyncAsset, mapSyncExif } from '../sync/passes';
import { eventPacket } from './protocol';

export interface ClientEventMap {
  on_upload_success: [Dto<'AssetResponseDto'>];
  on_user_delete: [string];
  on_asset_delete: [string];
  on_asset_trash: [string[]];
  on_asset_update: [Dto<'AssetResponseDto'>];
  on_asset_hidden: [string];
  on_asset_restore: [string[]];
  on_asset_stack_update: string[];
  on_album_update: [string];
  on_person_thumbnail: [string];
  on_server_version: [Dto<'ServerVersionResponseDto'>];
  on_config_update: [];
  on_new_release: [Dto<'ReleaseEventV1'>];
  on_notification: [Dto<'NotificationDto'>];
  on_session_delete: [string];
  AssetUploadReadyV2: [{ asset: Dto<'SyncAssetV2'>; exif: Dto<'SyncAssetExifV1'> }];
  AppRestartV1: [{ isMaintenanceMode: boolean }];
  AssetEditReadyV2: [{ asset: Dto<'SyncAssetV2'>; edit: Dto<'SyncAssetEditV1'>[] }];
}
export type ClientEvent = keyof ClientEventMap;

function hub(env: Env, userId: string) {
  return env.REALTIME.get(env.REALTIME.idFromName(userId));
}

async function sendPackets(env: Env, userId: string, packets: string[], sessionId?: string): Promise<void> {
  try {
    await hub(env, userId).send(packets, sessionId);
  } catch (err) {
    console.error('realtime emit failed', userId, packets.map((p) => p.slice(0, 60)), err);
  }
}

/** Sends an event to all of a user's connected clients. */
export async function emit<E extends ClientEvent>(env: Env, userId: string, event: E, ...args: ClientEventMap[E]): Promise<void> {
  await sendPackets(env, userId, [eventPacket(event, args)]);
}

/** Sends an event to the clients of one Immich session of a user (Immich's session room). */
export async function emitToSession<E extends ClientEvent>(
  env: Env,
  userId: string,
  sessionId: string,
  event: E,
  ...args: ClientEventMap[E]
): Promise<void> {
  await sendPackets(env, userId, [eventPacket(event, args)], sessionId);
}

/**
 * Ends a session's realtime connections: sends `on_session_delete` (Immich sends it to the session room,
 * and the web app logs out on it), then disconnects and closes those sockets. Call it after deleting a
 * session row (logout, DELETE /sessions/:id, DELETE /sessions, password change that drops sessions).
 * The hub does not re-check sessions on emit, so this call is what revokes a socket.
 */
export async function disconnectSession(env: Env, userId: string, sessionId: string): Promise<void> {
  try {
    await hub(env, userId).disconnect(sessionId, [eventPacket('on_session_delete', [sessionId])]);
  } catch (err) {
    console.error('realtime disconnect failed', userId, sessionId, err);
  }
}

/** disconnectSession for each of `sessionIds` (sessions deleted in one statement). */
export async function disconnectSessions(env: Env, userId: string, sessionIds: string[]): Promise<void> {
  await Promise.all(sessionIds.map((id) => disconnectSession(env, userId, id)));
}

/** Closes every realtime connection of a user (user deleted, all sessions revoked). */
export async function disconnectUser(env: Env, userId: string): Promise<void> {
  try {
    await hub(env, userId).disconnect();
  } catch (err) {
    console.error('realtime disconnect failed', userId, err);
  }
}

/** Sends an event to every non-deleted user's clients. */
export async function broadcast<E extends ClientEvent>(env: Env, event: E, ...args: ClientEventMap[E]): Promise<void> {
  try {
    const { results } = await env.DB.prepare('SELECT id FROM users WHERE deleted_at IS NULL').all<{ id: string }>();
    const packet = eventPacket(event, args);
    await Promise.all(results.map((u) => sendPackets(env, u.id, [packet])));
  } catch (err) {
    console.error('realtime broadcast failed', event, err);
  }
}

/**
 * After processing makes an upload visible: `on_upload_success` (web) and `AssetUploadReadyV2` (mobile),
 * as Immich's job service sends them, for timeline and archive assets only. V2 needs an EXIF row.
 */
export async function emitUploadReady(env: Env, assetId: string): Promise<void> {
  try {
    const a = await env.DB.prepare('SELECT * FROM assets WHERE id = ?1 AND deleted_at IS NULL').bind(assetId).first<AssetRow>();
    if (!a || (a.visibility !== 'timeline' && a.visibility !== 'archive')) return;
    const e = await env.DB.prepare('SELECT * FROM asset_exif WHERE asset_id = ?1').bind(assetId).first<ExifRow>();
    const packets = [eventPacket('on_upload_success', [mapAssetResponse(a, e)])];
    if (e) packets.push(eventPacket('AssetUploadReadyV2', [{ asset: mapSyncAsset(a), exif: mapSyncExif(e) }]));
    await sendPackets(env, a.owner_id, packets);
  } catch (err) {
    console.error('realtime upload-ready failed', assetId, err);
  }
}

/**
 * After a hard delete: `on_asset_delete` per asset to its owner, one hub call per owner.
 * Only ids whose rows are gone are announced (a guarded DELETE may have skipped some).
 */
export async function emitAssetsDeleted(env: Env, assets: Pick<AssetRow, 'id' | 'owner_id'>[]): Promise<void> {
  try {
    const remaining = new Set<string>();
    for (let i = 0; i < assets.length; i += 90) {
      const ids = assets.slice(i, i + 90).map((a) => a.id);
      const { results } = await env.DB.prepare(`SELECT id FROM assets WHERE id IN (${ids.map(() => '?').join(',')})`)
        .bind(...ids)
        .all<{ id: string }>();
      for (const r of results) remaining.add(r.id);
    }
    const byOwner = new Map<string, string[]>();
    for (const a of assets) {
      if (remaining.has(a.id)) continue;
      byOwner.set(a.owner_id, [...(byOwner.get(a.owner_id) ?? []), eventPacket('on_asset_delete', [a.id])]);
    }
    await Promise.all([...byOwner].map(([owner, packets]) => sendPackets(env, owner, packets)));
  } catch (err) {
    console.error('realtime asset-delete failed', err);
  }
}
