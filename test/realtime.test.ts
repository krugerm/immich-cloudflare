import { env, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { broadcast, disconnectUser, emit, emitToSession } from '../src/realtime/emit';
import type { RealtimeHub } from '../src/realtime/hub';
import { PING_INTERVAL, PING_TIMEOUT } from '../src/realtime/protocol';
import { encode } from 'fast-png';
import { purgeAssets, purgeTrash } from '../src/cron/purge';
import type { AssetRow } from '../src/db/rows';
import { processAsset } from '../src/process/consumer';
import type { Thumbnailer } from '../src/process/thumbs';
import { expectSchema } from './contract';
import { BASE, createUser, login, uploadAsset } from './helpers';
import { connect, open, URL_WS, userWithToken } from './realtime-helpers';
import sampleJpg from './fixtures/media/sample.jpg?arraybuffer';

function fakeThumbnailer(): Thumbnailer {
  const png = encode({ width: 4, height: 3, data: new Uint8Array(4 * 3 * 4).fill(200), channels: 4 });
  return { render: async () => png, info: async () => ({ width: 4, height: 3 }) };
}

describe('socket.io handshake', () => {
  it('sends the Engine.IO open packet, connects the main namespace and sends the server version', async () => {
    const { token } = await userWithToken('a@example.com');
    const { res, client } = await open({ 'x-immich-user-token': token });
    expect(res.status).toBe(101);
    const c = client!;
    const opened = await c.next();
    expect(opened[0]).toBe('0');
    const params = JSON.parse(opened.slice(1));
    expect(params).toEqual({ sid: expect.any(String), upgrades: [], pingInterval: 25000, pingTimeout: 20000, maxPayload: 1000000 });

    c.ws.send('40');
    const ack = await c.next();
    expect(ack.startsWith('40')).toBe(true);
    expect(JSON.parse(ack.slice(2))).toEqual({ sid: expect.any(String) });
    const version = await c.next();
    expect(JSON.parse(version.slice(2))).toEqual(['on_server_version', { major: 3, minor: 3, patch: 0, prerelease: null }]);
    c.ws.close();
  });

  it('accepts the auth payload variant 40{...} and the cookie, path without trailing slash, and sessionKey', async () => {
    const { token } = await userWithToken('b@example.com');
    for (const [headers, url] of [
      [{ cookie: `immich_access_token=${token}` }, URL_WS],
      [{}, `${BASE}/api/socket.io?EIO=4&transport=websocket&sessionKey=${token}`],
      [{ authorization: `Bearer ${token}` }, URL_WS],
    ] as const) {
      const { res, client } = await open(headers, url);
      expect(res.status).toBe(101);
      await client!.next((f) => f.startsWith('0'));
      client!.ws.send('40{"token":"ignored"}');
      expect((await client!.next()).startsWith('40{')).toBe(true);
      client!.ws.close();
    }
  });

  it('refuses other namespaces with CONNECT_ERROR', async () => {
    const { token } = await userWithToken('c@example.com');
    const { client } = await open({ 'x-immich-user-token': token });
    await client!.next((f) => f.startsWith('0'));
    client!.ws.send('40/admin,');
    expect(await client!.next()).toBe('44/admin,{"message":"Invalid namespace"}');
    client!.ws.close();
  });

  it('refuses an unauthenticated socket with CONNECT_ERROR and closes it', async () => {
    const { res, client } = await open({ 'x-immich-user-token': 'not-a-token' });
    expect(res.status).toBe(101);
    expect((await client!.next())[0]).toBe('0');
    expect(await client!.next()).toBe('44{"message":"unauthorized"}');
    expect(await client!.waitClosed()).toBe(true);
  });

  it('rejects polling, wrong protocol versions and plain GETs with Engine.IO errors', async () => {
    const polling = await SELF.fetch(`${BASE}/api/socket.io/?EIO=4&transport=polling`);
    expect(polling.status).toBe(400);
    expect(await polling.json()).toEqual({ code: 0, message: 'Transport unknown' });
    const eio3 = await SELF.fetch(`${BASE}/api/socket.io/?EIO=3&transport=websocket`, { headers: { upgrade: 'websocket' } });
    expect(eio3.status).toBe(400);
    expect(await eio3.json()).toEqual({ code: 5, message: 'Unsupported protocol version' });
    const noUpgrade = await SELF.fetch(URL_WS);
    expect(noUpgrade.status).toBe(400);
  });
});

describe('security', () => {
  it('rejects a cookie-authenticated upgrade from another origin with 403', async () => {
    const { token } = await userWithToken('n@example.com');
    const cookie = `immich_access_token=${token}`;
    const evil = await SELF.fetch(URL_WS, { headers: { upgrade: 'websocket', cookie, origin: 'https://evil.example' } });
    expect(evil.status).toBe(403);
    expect(evil.webSocket).toBeNull();
    // An empty bearer header must not count as a non-cookie credential.
    const sneaky = await SELF.fetch(URL_WS, { headers: { upgrade: 'websocket', cookie, origin: 'https://evil.example', authorization: 'Bearer ' } });
    expect(sneaky.status).toBe(403);

    // Web app on our own origin, and the mobile app: native cookie jar, no Origin header.
    for (const headers of [{ cookie, origin: BASE }, { cookie }] as Record<string, string>[]) {
      const { res, client } = await open(headers);
      expect(res.status).toBe(101);
      client!.ws.close();
    }
  });

  it('accepts token auth (header or query) from any origin', async () => {
    const { token } = await userWithToken('o@example.com');
    for (const [headers, url] of [
      [{ 'x-immich-user-token': token, origin: 'https://other.example' }, URL_WS],
      [{ origin: 'https://other.example' }, `${URL_WS}&sessionKey=${token}`],
    ] as const) {
      const { res, client } = await open(headers, url);
      expect(res.status).toBe(101);
      client!.ws.close();
    }
  });

  it('logout sends on_session_delete, disconnects that session’s sockets and leaves other sessions connected', async () => {
    const { user, token } = await userWithToken('p@example.com');
    const token2 = await login('p@example.com');
    const c1 = await connect({ 'x-immich-user-token': token });
    const c2 = await connect({ 'x-immich-user-token': token2 });

    const res = await SELF.fetch(`${BASE}/api/auth/logout`, { method: 'POST', headers: { 'x-immich-user-token': token } });
    expect(res.status).toBe(200);

    expect((await c1.next()).startsWith('42["on_session_delete",')).toBe(true);
    expect(await c1.next()).toBe('41');
    expect(await c1.waitClosed()).toBe(true);

    await emit(env, user.id, 'on_config_update');
    expect(await c2.next()).toBe('42["on_config_update"]');
    expect(c2.closed).toBe(false);
    c2.ws.close();
  });

  it('disconnectUser closes every socket of the user', async () => {
    const { user, token } = await userWithToken('q@example.com');
    const c = await connect({ 'x-immich-user-token': token });
    await disconnectUser(env, user.id);
    expect(await c.next()).toBe('41');
    expect(await c.waitClosed()).toBe(true);
  });
});

describe('ping/pong', () => {
  it('answers a client ping and closes on Engine.IO close', async () => {
    const { token } = await userWithToken('d@example.com');
    const c = await connect({ 'x-immich-user-token': token });
    c.ws.send('2probe');
    expect(await c.next()).toBe('3probe');
    c.ws.send('1');
    expect(await c.waitClosed()).toBe(true);
  });

  it('sends server pings from the alarm and drops sockets that stop answering', async () => {
    const { user, token } = await userWithToken('e@example.com');
    const c = await connect({ 'x-immich-user-token': token });
    const stub = env.REALTIME.get(env.REALTIME.idFromName(user.id));

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await c.next()).toBe('2');
    c.ws.send('3');
    await new Promise((r) => setTimeout(r, 50));

    // Pretend the last pong is older than pingInterval + pingTimeout.
    await runInDurableObject(stub, async (_hub: RealtimeHub, state) => {
      for (const ws of state.getWebSockets()) {
        ws.serializeAttachment({ ...ws.deserializeAttachment(), lastSeen: Date.now() - PING_INTERVAL - PING_TIMEOUT - 1 });
      }
    });
    await runDurableObjectAlarm(stub);
    expect(await c.waitClosed()).toBe(true);
    // No sockets left, so the alarm is not re-armed.
    expect(await runInDurableObject(stub, (_hub: RealtimeHub, state) => state.storage.getAlarm())).toBeNull();
  });
});

describe('emit', () => {
  it('delivers 42 frames to the target user only, and to namespace-connected sockets only', async () => {
    const a = await userWithToken('f@example.com');
    const b = await userWithToken('g@example.com');
    const ca = await connect({ 'x-immich-user-token': a.token });
    const cb = await connect({ 'x-immich-user-token': b.token });
    // A second socket of user A that never joined the namespace.
    const pending = (await open({ 'x-immich-user-token': a.token })).client!;
    await pending.next((f) => f.startsWith('0'));

    await emit(env, a.user.id, 'on_asset_trash', ['x', 'y']);
    await emit(env, a.user.id, 'on_config_update');

    expect(await ca.next()).toBe('42["on_asset_trash",["x","y"]]');
    expect(await ca.next()).toBe('42["on_config_update"]');
    expect(await cb.drain()).toEqual([]);
    expect(await pending.drain()).toEqual([]);
    for (const c of [ca, cb, pending]) c.ws.close();
  });

  it('emitToSession reaches only that session; broadcast reaches every user', async () => {
    const a = await userWithToken('h@example.com');
    const b = await userWithToken('i@example.com');
    const tokenA2 = await login('h@example.com');
    const ca1 = await connect({ 'x-immich-user-token': a.token });
    const ca2 = await connect({ 'x-immich-user-token': tokenA2 });
    const cb = await connect({ 'x-immich-user-token': b.token });
    const sessionA2 = (await env.DB.prepare('SELECT id FROM sessions WHERE user_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .bind(a.user.id)
      .first<string>('id'))!;

    await emitToSession(env, a.user.id, sessionA2, 'on_session_delete', sessionA2);
    expect(await ca2.next()).toBe(`42["on_session_delete","${sessionA2}"]`);
    expect(await ca1.drain()).toEqual([]);

    await broadcast(env, 'on_config_update');
    for (const c of [ca1, ca2, cb]) expect(await c.next()).toBe('42["on_config_update"]');
    for (const c of [ca1, ca2, cb]) c.ws.close();
  });

  it('wiring: processing sends on_upload_success and AssetUploadReadyV2 to the owner only', async () => {
    const a = await userWithToken('j@example.com');
    const b = await userWithToken('k@example.com');
    const ca = await connect({ 'x-immich-user-token': a.token });
    const cb = await connect({ 'x-immich-user-token': b.token });
    const id = (await uploadAsset(a.token, new Uint8Array(sampleJpg))).body.id;

    await processAsset(env, id, fakeThumbnailer());

    const success = JSON.parse((await ca.next((f) => f.startsWith('42["on_upload_success"'))).slice(2));
    expect(success[1].id).toBe(id);
    expectSchema('AssetResponseDto', success[1]);
    const ready = JSON.parse((await ca.next((f) => f.startsWith('42["AssetUploadReadyV2"'))).slice(2));
    expect(ready[1].asset.id).toBe(id);
    expectSchema('SyncAssetV2', ready[1].asset);
    expectSchema('SyncAssetExifV1', ready[1].exif);
    expect(await cb.drain()).toEqual([]);
    ca.ws.close();
    cb.ws.close();
  });

  it('wiring: hidden assets send nothing; needs_media assets send on_upload_success', async () => {
    const a = await userWithToken('l@example.com');
    const ca = await connect({ 'x-immich-user-token': a.token });
    const hidden = (await uploadAsset(a.token, new Uint8Array(sampleJpg))).body.id;
    await env.DB.prepare("UPDATE assets SET visibility = 'hidden' WHERE id = ?1").bind(hidden).run();
    await processAsset(env, hidden, fakeThumbnailer());
    expect(await ca.drain()).toEqual([]);

    const video = (await uploadAsset(a.token, crypto.getRandomValues(new Uint8Array(200)), { filename: 'clip.mp4' })).body.id;
    await processAsset(env, video, fakeThumbnailer());
    const frame = await ca.next((f) => f.startsWith('42["on_upload_success"'));
    expect(JSON.parse(frame.slice(2))[1].id).toBe(video);
    ca.ws.close();
  });

  it('wiring: purge sends on_asset_delete per purged asset to its owner', async () => {
    const a = await userWithToken('m@example.com');
    const ca = await connect({ 'x-immich-user-token': a.token });
    const id = (await uploadAsset(a.token, crypto.getRandomValues(new Uint8Array(100)))).body.id;
    await env.DB.prepare("UPDATE assets SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1").bind(id).run();

    expect(await purgeTrash(env, new Date('2026-03-15T00:00:00.000Z'))).toBe(1);

    expect(await ca.next()).toBe(`42["on_asset_delete","${id}"]`);
    ca.ws.close();
  });

  it('wiring: purge announces nothing for a row the guarded DELETE kept', async () => {
    const a = await userWithToken('r@example.com');
    const ca = await connect({ 'x-immich-user-token': a.token });
    const id = (await uploadAsset(a.token, crypto.getRandomValues(new Uint8Array(100)))).body.id;
    // Restored between selection and commit: deleted_at is NULL, so the trashed-row DELETE skips it.
    const row = (await env.DB.prepare('SELECT * FROM assets WHERE id = ?1').bind(id).first<AssetRow>())!;
    await purgeAssets(env, [row], new Date());
    expect(await env.DB.prepare('SELECT id FROM assets WHERE id = ?1').bind(id).first('id')).toBe(id);
    expect(await ca.drain()).toEqual([]);
    ca.ws.close();
  });

  it('never throws when the hub is unreachable', async () => {
    const broken = { ...env, REALTIME: { idFromName: () => { throw new Error('boom'); } } } as unknown as Env;
    await expect(emit(broken, 'u', 'on_config_update')).resolves.toBeUndefined();
    await expect(broadcast(broken, 'on_config_update')).resolves.toBeUndefined();
  });
});
