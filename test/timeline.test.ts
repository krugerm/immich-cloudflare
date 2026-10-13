import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { expectResponse } from './contract';
import { authHeaders, BASE, createUser, login, uploadAsset } from './helpers';
import fixtureBuckets from './fixtures/immich-3.3.0/timeline-buckets.json';

async function setup() {
  await createUser();
  const token = await login();
  const dates = ['2024-05-04T10:00:00.000Z', '2024-05-20T10:00:00.000Z', '2023-12-31T23:00:00.000Z'];
  const ids: string[] = [];
  for (const [i, d] of dates.entries()) {
    const { body } = await uploadAsset(token, crypto.getRandomValues(new Uint8Array(100 + i)), { fields: { fileCreatedAt: d, fileModifiedAt: d } });
    ids.push(body.id);
  }
  return { token, ids };
}

const get = (token: string, q: string) => SELF.fetch(`${BASE}/api/timeline/${q}`, { headers: authHeaders(token) });

describe('timeline', () => {
  it('lists month buckets newest first in Immich format', async () => {
    const { token } = await setup();
    const res = await get(token, 'buckets?visibility=timeline');
    const body = await res.json();
    expectResponse('/timeline/buckets', 'get', 200, body);
    expect(body).toEqual([
      { timeBucket: '2024-05-01', count: 2 },
      { timeBucket: '2023-12-01', count: 1 },
    ]);
    expect(Object.keys((body as any[])[0]).sort()).toEqual(Object.keys(fixtureBuckets[0]).sort());
  });

  it('returns one bucket as column arrays', async () => {
    const { token, ids } = await setup();
    const res = await get(token, 'bucket?visibility=timeline&timeBucket=2024-05-01');
    const body = (await res.json()) as Record<string, unknown[]>;
    expectResponse('/timeline/bucket', 'get', 200, body);
    expect(body.id).toEqual([ids[1], ids[0]]); // newest first
    expect(body.isImage).toEqual([true, true]);
    expect(body.isTrashed).toEqual([false, false]);
  });

  it('excludes trashed and hidden assets from the default timeline', async () => {
    const { token, ids } = await setup();
    await env.DB.prepare("UPDATE assets SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1").bind(ids[0]).run();
    await env.DB.prepare("UPDATE assets SET visibility = 'hidden' WHERE id = ?1").bind(ids[1]).run();
    expect(await (await get(token, 'buckets?visibility=timeline')).json()).toEqual([{ timeBucket: '2023-12-01', count: 1 }]);
    expect(await (await get(token, 'buckets?isTrashed=true')).json()).toEqual([{ timeBucket: '2024-05-01', count: 1 }]);
  });
});
