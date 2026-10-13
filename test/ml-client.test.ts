import { Container } from '@cloudflare/containers';
import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ML_TIMEOUT_MS, mlClient } from '../src/ml/client';
import {
  CLIP_DIM,
  CLIP_MODEL,
  FACE_DIM,
  FACE_MODEL,
  MlBadImageError,
  MlInputError,
  MlUnavailableError,
  type MlClient,
} from '../src/ml/contract';
import { MlContainer, ML_PORT_READY_TIMEOUT_MS } from '../src/ml/hub';
import { handleMlBatch, processMl, type MlMessage } from '../src/ml/job';
import { thumbKey } from '../src/process/thumbs';
import { createUser, login, uploadAsset } from './helpers';

interface Call {
  name: string;
  request: Request;
  signal: AbortSignal | null | undefined;
}

/** A DurableObjectNamespace stand-in: idFromName/get return stubs whose fetch runs `respond`. */
function fakeNamespace(respond: (req: Request) => Promise<Response>) {
  const calls: Call[] = [];
  const ns = {
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => ({
      fetch: async (url: string, init?: RequestInit) => {
        const request = new Request(url, init);
        calls.push({ name: id.name, request: request.clone(), signal: init?.signal });
        return respond(request);
      },
    }),
  };
  // No search container: text queries go to the full container's "search" instance (the fallback path).
  return { calls, ns, env: { ...env, ML_CONTAINER: ns, ML_SEARCH: undefined } as unknown as Env };
}

// Immich's ML server serialises each embedding as a JSON array string (orjson of a numpy array).
const vec = (n: number, v = 0.01) => Array.from({ length: n }, (_, i) => v + i / 1e4);
const enc = (values: number[]) => JSON.stringify(values);

const clip = vec(CLIP_DIM);
const faceEmb = vec(FACE_DIM, 0.02);
const face = { boundingBox: { x1: 10, y1: 20, x2: 110, y2: 140 }, score: 0.93, embedding: enc(faceEmb) };
const image = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

async function form(call: Call) {
  const data = await call.request.formData();
  return { data, entries: JSON.parse(data.get('entries') as string) as unknown };
}

describe('ml client', () => {
  it('returns undefined without the ML_CONTAINER binding', () => {
    expect(mlClient({ ...env, ML_CONTAINER: undefined } as unknown as Env)).toBeUndefined();
  });

  it('posts one multipart /predict with clip visual and facial-recognition entries as Immich does', async () => {
    const fake = fakeNamespace(async () =>
      Response.json({ clip: enc(clip), 'facial-recognition': [face], imageHeight: 1080, imageWidth: 1440 }),
    );
    const result = await mlClient(fake.env)!.predict(image, { clip: true, faces: true });

    expect(fake.calls).toHaveLength(1);
    const [call] = fake.calls;
    expect(call.name).toMatch(/^instance-[01]$/);
    expect(call.request.method).toBe('POST');
    expect(call.request.url).toBe('http://container/predict');
    expect(call.request.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/);
    expect(call.signal).toBeInstanceOf(AbortSignal);

    const { data, entries } = await form(call);
    // Same keys and option shapes as machine-learning.repository.ts encodeImage + detectFaces, merged into one request.
    expect(entries).toEqual({
      clip: { visual: { modelName: CLIP_MODEL } },
      'facial-recognition': {
        detection: { modelName: FACE_MODEL, options: { minScore: 0.7 } },
        recognition: { modelName: FACE_MODEL },
      },
    });
    const file = data.get('image') as File;
    expect(file).toBeInstanceOf(File);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(image);
    expect(data.has('text')).toBe(false);

    expect(result.imageWidth).toBe(1440);
    expect(result.imageHeight).toBe(1080);
    expect(result.clip).toHaveLength(CLIP_DIM);
    expect(result.clip![5]).toBeCloseTo(clip[5], 10);
    expect(result.faces).toHaveLength(1);
    expect(result.faces![0].boundingBox).toEqual(face.boundingBox);
    expect(result.faces![0].score).toBe(0.93);
    expect(result.faces![0].embedding).toHaveLength(FACE_DIM);
    expect(result.faces![0].embedding[7]).toBeCloseTo(faceEmb[7], 10);
  });

  it('asks only for clip when faces are not wanted, and returns faces null', async () => {
    const fake = fakeNamespace(async () => Response.json({ clip: enc(clip), imageHeight: 10, imageWidth: 20 }));
    const result = await mlClient(fake.env)!.predict(image, { clip: true, faces: false });
    expect((await form(fake.calls[0])).entries).toEqual({ clip: { visual: { modelName: CLIP_MODEL } } });
    expect(result.faces).toBeNull();
    expect(result.clip).toHaveLength(CLIP_DIM);
    expect([result.imageWidth, result.imageHeight]).toEqual([20, 10]);
  });

  it('asks only for faces when clip is not wanted, and returns clip null; no faces is an empty list', async () => {
    const fake = fakeNamespace(async () =>
      Response.json({ 'facial-recognition': [], imageHeight: 10, imageWidth: 20 }),
    );
    const result = await mlClient(fake.env)!.predict(image, { clip: false, faces: true });
    expect((await form(fake.calls[0])).entries).toEqual({
      'facial-recognition': {
        detection: { modelName: FACE_MODEL, options: { minScore: 0.7 } },
        recognition: { modelName: FACE_MODEL },
      },
    });
    expect(result.clip).toBeNull();
    expect(result.faces).toEqual([]);
  });

  it('makes no request when nothing is wanted', async () => {
    const fake = fakeNamespace(async () => Response.json({}));
    const result = await mlClient(fake.env)!.predict(image, { clip: false, faces: false });
    expect(fake.calls).toHaveLength(0);
    expect(result).toEqual({ clip: null, faces: null, imageWidth: 0, imageHeight: 0 });
  });

  it('embeds text with a clip.textual entry and a text field', async () => {
    const fake = fakeNamespace(async () => Response.json({ clip: enc(clip) }));
    const result = await mlClient(fake.env)!.embedText('beach at sunset');
    const { data, entries } = await form(fake.calls[0]);
    // encodeText sends options: { language }; with no language JSON.stringify leaves options empty.
    expect(entries).toEqual({ clip: { textual: { modelName: CLIP_MODEL, options: {} } } });
    expect(data.get('text')).toBe('beach at sunset');
    expect(data.has('image')).toBe(false);
    expect(result).toHaveLength(CLIP_DIM);
    expect(result[3]).toBeCloseTo(clip[3], 10);
  });

  it('rejects an embedding of the wrong size as unavailable (wrong model), never as bad input', async () => {
    const fake = fakeNamespace(async () => Response.json({ clip: enc(vec(512)) }));
    const err = await mlClient(fake.env)!.embedText('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MlUnavailableError);
    expect((err as Error).message).toMatch(/512/);
  });

  it.each([400, 422])('maps %i to MlInputError with the server detail', async (status) => {
    const fake = fakeNamespace(async () => Response.json({ detail: 'Image has zero width or height' }, { status }));
    const p = mlClient(fake.env)!.predict(image, { clip: true, faces: true });
    await expect(p).rejects.toBeInstanceOf(MlInputError);
    await expect(p).rejects.toThrow('Image has zero width or height');
  });

  it.each([500, 502, 503, 429, 404])('maps %i to MlUnavailableError so the queue retries', async (status) => {
    const fake = fakeNamespace(async () => new Response('upstream exploded', { status }));
    const err = await mlClient(fake.env)!
      .predict(image, { clip: true, faces: true })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MlUnavailableError);
    expect((err as Error).message).toContain(String(status));
  });

  it('maps a timeout or a stub failure to MlUnavailableError', async () => {
    for (const thrown of [
      new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
      new Error('Container crashed while checking for ports'),
    ]) {
      const fake = fakeNamespace(async () => {
        throw thrown;
      });
      const err = await mlClient(fake.env)!.embedText('dog').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MlUnavailableError);
      expect((err as Error).message).toMatch(/^ml container (timeout|error)/);
    }
  });

  it('maps the container wrapper 500 after a slow cold start to MlUnavailableError', async () => {
    const fake = fakeNamespace(
      async () => new Response('Failed to start container: container did not start in time', { status: 500 }),
    );
    const err = await mlClient(fake.env)!
      .predict(image, { clip: true, faces: true })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MlUnavailableError);
  });

  it('maps a JSON 500 detail (model failed to load) to MlUnavailableError', async () => {
    const fake = fakeNamespace(async () =>
      Response.json({ detail: "Failed to load model 'ViT-B-16-SigLIP2__webli'" }, { status: 500 }),
    );
    const err = await mlClient(fake.env)!
      .predict(image, { clip: true, faces: true })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MlUnavailableError);
  });

  it("maps an image request's bare FastAPI 500 (Pillow could not decode) to MlBadImageError", async () => {
    const fake = fakeNamespace(async () => new Response('Internal Server Error', { status: 500 }));
    const err = await mlClient(fake.env)!
      .predict(image, { clip: true, faces: true })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MlBadImageError);
    // Not terminal by itself: the job decides on the final attempt.
    expect(err).not.toBeInstanceOf(MlInputError);
    expect(err).not.toBeInstanceOf(MlUnavailableError);
  });

  it('maps a bare 500 on a text request to MlUnavailableError (there is no image to blame)', async () => {
    const fake = fakeNamespace(async () => new Response('Internal Server Error', { status: 500 }));
    const err = await mlClient(fake.env)!.embedText('dog').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MlUnavailableError);
  });

  it('sends text search to the fixed "search" instance and image jobs to the two random instances', async () => {
    const fake = fakeNamespace(async (req) =>
      (await req.formData()).has('text')
        ? Response.json({ clip: enc(clip) })
        : Response.json({ clip: enc(clip), imageHeight: 1, imageWidth: 1 }),
    );
    const client = mlClient(fake.env)!;
    await client.embedText('a');
    await client.embedText('b');
    await client.predict(image, { clip: true, faces: false });
    expect(fake.calls.map((c) => c.name).slice(0, 2)).toEqual(['search', 'search']);
    expect(fake.calls[2].name).toMatch(/^instance-[01]$/);
    expect(ML_TIMEOUT_MS).toBe(90_000);
  });

  it('sends text search to the text-only search container when it is bound, and image jobs to the full one', async () => {
    const respond = async (req: Request) =>
      (await req.formData()).has('text') ? Response.json({ clip: enc(clip) }) : Response.json({ clip: enc(clip), imageHeight: 1, imageWidth: 1 });
    const full = fakeNamespace(respond);
    const search = fakeNamespace(respond);
    const client = mlClient({ ...full.env, ML_SEARCH: search.ns } as unknown as Env)!;
    await client.embedText('beach');
    await client.predict(image, { clip: true, faces: false });
    expect(search.calls.map((c) => c.name)).toEqual(['search']);
    expect(full.calls.map((c) => c.name)).toEqual([expect.stringMatching(/^instance-[01]$/)]);
  });

  it('maps a 200 with a body that is not Immich JSON to MlUnavailableError', async () => {
    const fake = fakeNamespace(async () => new Response('<html>proxy</html>', { status: 200 }));
    const err = await mlClient(fake.env)!
      .predict(image, { clip: true, faces: false })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MlUnavailableError);
  });
});

describe('MlContainer cold start', () => {
  afterEach(() => vi.restoreAllMocks());

  /** MlContainer.fetch run against a stand-in `this`; Container.prototype.fetch (the proxy) is stubbed. */
  function harness(running: boolean, status: string, start: () => Promise<void> = async () => {}) {
    const startCalls: unknown[][] = [];
    const proxied = vi.spyOn(Container.prototype, 'fetch').mockResolvedValue(new Response('proxied'));
    const self = {
      ctx: { container: { running } },
      getState: async () => ({ status, lastChange: 0 }),
      startAndWaitForPorts: async (...args: unknown[]) => {
        startCalls.push(args);
        await start();
      },
    };
    const call = (req: Request) => MlContainer.prototype.fetch.call(self as unknown as MlContainer, req);
    return { startCalls, proxied, call };
  }

  it('waits up to 120 s for port 3003 on a cold instance before proxying', async () => {
    let started = false;
    const h = harness(false, 'stopped', async () => {
      await new Promise((r) => setTimeout(r, 50)); // a slow start: the proxy must not run before it ends
      started = true;
    });
    h.proxied.mockImplementation(async () => new Response(started ? 'after start' : 'too early'));
    const res = await h.call(new Request('http://container/predict', { method: 'POST' }));
    expect(await res.text()).toBe('after start');
    expect(h.startCalls).toHaveLength(1);
    expect(h.startCalls[0][0]).toBe(3003);
    expect(h.startCalls[0][1]).toMatchObject({ portReadyTimeoutMS: 120_000 });
    expect(ML_PORT_READY_TIMEOUT_MS).toBe(120_000);
  });

  it('proxies straight away when the instance is running and healthy', async () => {
    const h = harness(true, 'healthy');
    expect(await (await h.call(new Request('http://container/predict'))).text()).toBe('proxied');
    expect(h.startCalls).toHaveLength(0);
  });

  it('still hands over to the library when the long wait fails, so its 500/503 reaches the client', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness(false, 'stopped', async () => {
      throw new Error('port 3003 not ready');
    });
    h.proxied.mockResolvedValue(new Response('Failed to start container: x', { status: 500 }));
    const res = await h.call(new Request('http://container/predict'));
    expect(res.status).toBe(500);
    expect(h.proxied).toHaveBeenCalledOnce();
  });
});

describe('processMl and a bad image', () => {
  async function readyAsset(newUser = true) {
    if (newUser) await createUser();
    const token = await login();
    const id = (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(100)))).body.id as string;
    await env.DB.prepare("UPDATE assets SET status = 'ready' WHERE id = ?1").bind(id).run();
    await env.MEDIA.put(thumbKey(id, 'preview'), new Uint8Array([0xff, 0xd8, 0xff, 1, 2]));
    return id;
  }
  const mlAt = (id: string) => env.DB.prepare('SELECT ml_at FROM assets WHERE id = ?1').bind(id).first<string | null>('ml_at');
  const badImage: MlClient = {
    predict: async () => {
      throw new MlBadImageError('ml container 500: Internal Server Error');
    },
    embedText: async () => [],
  };

  it('retries on attempts before the last and stamps ml_at on the final attempt', async () => {
    const id = await readyAsset();
    for (const attempts of [1, 4]) {
      await expect(processMl(env, { assetId: id }, badImage, { attempts })).rejects.toBeInstanceOf(MlBadImageError);
      expect(await mlAt(id)).toBeNull();
    }
    await expect(processMl(env, { assetId: id }, badImage)).rejects.toBeInstanceOf(MlBadImageError);
    expect(await mlAt(id)).toBeNull();
    await processMl(env, { assetId: id }, badImage, { attempts: 5 });
    expect(await mlAt(id)).toBeTruthy();
  });

  it('handleMlBatch passes the delivery attempt through', async () => {
    const id = await readyAsset();
    const second = await readyAsset(false);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const outcome: Record<string, string> = {};
    const message = (assetId: string, attempts: number) => ({
      id: assetId,
      timestamp: new Date(),
      attempts,
      body: { assetId } satisfies MlMessage,
      ack: () => (outcome[assetId] = 'ack'),
      retry: () => (outcome[assetId] = 'retry'),
    });
    const batch = { queue: 'asset-ml', messages: [message(id, 5), message(second, 2)], retryAll: () => {}, ackAll: () => {} };
    await handleMlBatch(batch as unknown as MessageBatch<MlMessage>, env, badImage);
    expect(outcome).toEqual({ [id]: 'ack', [second]: 'retry' });
    expect(await mlAt(id)).toBeTruthy();
    expect(await mlAt(second)).toBeNull();
  });
});
