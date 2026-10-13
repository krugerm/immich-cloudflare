import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { fromBlob, MlInputError, MlUnavailableError, toBlob, type MlClient, type MlImageResult } from '../src/ml/contract';
import { processMl } from '../src/ml/job';
import { fakeVectorStore } from '../src/ml/vectors';
import { thumbKey } from '../src/process/thumbs';
import { createUser, login, uploadAsset } from './helpers';

const result: MlImageResult = { clip: [0.1, 0.2], faces: [], imageWidth: 4, imageHeight: 3 };

function fakeMl(outcome: MlImageResult | Error = result): MlClient & { calls: Array<{ bytes: number; want: unknown }> } {
  const calls: Array<{ bytes: number; want: unknown }> = [];
  return {
    calls,
    async predict(image, want) {
      calls.push({ bytes: image.byteLength, want });
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    async embedText() {
      return [1, 0];
    },
  };
}

async function readyAsset(withPreview = true) {
  await createUser();
  const token = await login();
  const id = (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(100)))).body.id as string;
  await env.DB.prepare("UPDATE assets SET status = 'ready' WHERE id = ?1").bind(id).run();
  if (withPreview) await env.MEDIA.put(thumbKey(id, 'preview'), new Uint8Array([0xff, 0xd8, 0xff, 1, 2]));
  return id;
}

const mlAt = (id: string) => env.DB.prepare('SELECT ml_at FROM assets WHERE id = ?1').bind(id).first<string | null>('ml_at');

describe('processMl', () => {
  it('sends the preview to the ML client and stamps ml_at', async () => {
    const id = await readyAsset();
    const ml = fakeMl();
    await processMl(env, { assetId: id }, ml);
    expect(ml.calls).toEqual([{ bytes: 5, want: { clip: true, faces: true } }]);
    expect(await mlAt(id)).toBeTruthy();
  });

  it('skips an asset already processed unless forced', async () => {
    const id = await readyAsset();
    const ml = fakeMl();
    await processMl(env, { assetId: id }, ml);
    await processMl(env, { assetId: id }, ml);
    expect(ml.calls).toHaveLength(1);
    await processMl(env, { assetId: id, force: true, faces: false }, ml);
    expect(ml.calls[1].want).toEqual({ clip: true, faces: false });
  });

  it('stamps an undecodable image and retries an unavailable container', async () => {
    const id = await readyAsset();
    await processMl(env, { assetId: id }, fakeMl(new MlInputError('bad image')));
    expect(await mlAt(id)).toBeTruthy();

    const other = await (async () => {
      const token = await login();
      const oid = (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(101)))).body.id as string;
      await env.DB.prepare("UPDATE assets SET status = 'ready' WHERE id = ?1").bind(oid).run();
      await env.MEDIA.put(thumbKey(oid, 'preview'), new Uint8Array([0xff, 0xd8]));
      return oid;
    })();
    await expect(processMl(env, { assetId: other }, fakeMl(new MlUnavailableError('cold')))).rejects.toThrow('cold');
    expect(await mlAt(other)).toBeNull();
  });

  it('runs one job per asset at a time: a second job skips a claimed asset, an expired claim is taken over', async () => {
    const id = await readyAsset();
    await env.DB.prepare('UPDATE assets SET ml_claim_at = ?2 WHERE id = ?1').bind(id, new Date().toISOString()).run();
    const ml = fakeMl();
    await processMl(env, { assetId: id }, ml);
    expect(ml.calls).toHaveLength(0);
    expect(await mlAt(id)).toBeNull();
    await env.DB.prepare("UPDATE assets SET ml_claim_at = '2020-01-01T00:00:00.000Z' WHERE id = ?1").bind(id).run();
    await processMl(env, { assetId: id }, ml);
    expect(ml.calls).toHaveLength(1);
    expect(await mlAt(id)).toBeTruthy();
    expect(await env.DB.prepare('SELECT ml_claim_at FROM assets WHERE id = ?1').bind(id).first('ml_claim_at')).toBeNull();
  });

  it('releases the claim when the job fails, so the retry can run', async () => {
    const id = await readyAsset();
    await expect(processMl(env, { assetId: id }, fakeMl(new MlUnavailableError('cold')))).rejects.toThrow('cold');
    expect(await env.DB.prepare('SELECT ml_claim_at FROM assets WHERE id = ?1').bind(id).first('ml_claim_at')).toBeNull();
  });

  it('ignores assets that are not ready or are trashed', async () => {
    const id = await readyAsset();
    await env.DB.prepare("UPDATE assets SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1").bind(id).run();
    const ml = fakeMl();
    await processMl(env, { assetId: id }, ml);
    expect(ml.calls).toHaveLength(0);
  });
});

describe('vector helpers', () => {
  it('round-trips float32 blobs', () => {
    expect(fromBlob(toBlob([0.5, -1, 2.25]))).toEqual([0.5, -1, 2.25]);
  });

  it('the fake store ranks by cosine and applies namespace and $in filters', async () => {
    const s = fakeVectorStore('clip');
    await s.upsert([
      { id: 'a', values: [1, 0], metadata: { ownerId: 'u1' } },
      { id: 'b', values: [0.7, 0.7], metadata: { ownerId: 'u2' } },
      { id: 'c', values: [0, 1], namespace: 'n', metadata: { ownerId: 'u1' } },
    ]);
    expect((await s.query([1, 0], { topK: 3 })).map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect((await s.query([1, 0], { topK: 3, filter: { ownerId: { $in: ['u2'] } } })).map((m) => m.id)).toEqual(['b']);
    expect((await s.query([1, 0], { topK: 3, namespace: 'n' })).map((m) => m.id)).toEqual(['c']);
    await s.deleteByIds(['a']);
    expect((await s.query([1, 0], { topK: 3, filter: { ownerId: 'u1' } })).map((m) => m.id)).toEqual(['c']);
  });
});
