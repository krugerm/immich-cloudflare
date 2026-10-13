import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { grantKey } from '../src/container/grant';
import { MediaContainer } from '../src/container/hub';

describe('MediaContainer', () => {
  it('registers the media.r2 outbound handler through the Container setter', async () => {
    // ContainerProxy looks handlers up in a registry the static setter fills; an own property would be invisible to it.
    expect(Object.getOwnPropertyDescriptor(MediaContainer, 'outboundByHost')).toBeUndefined();
    const handler = MediaContainer.outboundByHost?.['media.r2'];
    expect(handler).toBeTypeOf('function');

    await env.MEDIA.put('originals/u/h.mov', new Uint8Array([7, 8, 9]));
    const key = await grantKey(env.MEDIA_GRANT_SECRET!, 'read', 'originals/u/h.mov');
    const res = await handler!(new Request(`http://media.r2/${key}`, { headers: { range: 'bytes=1-' } }), env, {
      containerId: 'x',
      className: 'MediaContainer',
    } as never);
    expect(res.status).toBe(206);
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([8, 9]);
  });
});
