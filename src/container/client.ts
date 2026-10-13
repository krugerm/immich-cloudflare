import { getRandom } from '@cloudflare/containers';
import { MediaInputError, type ImageResult, type MediaProcessor, type VideoResult } from './contract';
import { grantKey } from './grant';
import { mediaGrantSecret } from './grant-secret';

const INSTANCES = 3;
const TIMEOUT_MS = 120_000;

type Namespace = Env['MEDIA_CONTAINER'];

async function call<T>(ns: Namespace, path: string, payload: Record<string, string>): Promise<T> {
  let res: Response;
  try {
    const stub = await getRandom(ns, INSTANCES);
    res = await stub.fetch(`http://container/${path}`, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new Error(`media container ${timeout ? 'timeout' : 'error'}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status === 200) return (await res.json()) as T;
  const text = await res.text();
  if (res.status === 422) {
    let message = text;
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed.error === 'string') message = parsed.error;
    } catch {
      // Plain-text body: use it as the message.
    }
    throw new MediaInputError(message);
  }
  throw new Error(`media container ${res.status}: ${text}`);
}

/** A MediaProcessor backed by the MEDIA_CONTAINER binding, or undefined without one. */
export function containerProcessor(env: Env): MediaProcessor | undefined {
  // Optional at runtime: tests and deployments without the container pass an env without it.
  const ns = env.MEDIA_CONTAINER as Namespace | undefined;
  if (!ns) return undefined;
  // Keys go to the container wrapped in per-job grants: read for the original, write for the one derived output.
  const grants = async (key: string, outKey: string) => {
    const secret = await mediaGrantSecret(env);
    return [await grantKey(secret, 'read', key), await grantKey(secret, 'write', outKey)];
  };
  return {
    video: async (key, posterKey) => {
      const [k, out] = await grants(key, posterKey);
      return call<VideoResult>(ns, 'video', { key: k, posterKey: out });
    },
    image: async (key, outKey) => {
      const [k, out] = await grants(key, outKey);
      return call<ImageResult>(ns, 'image', { key: k, outKey: out });
    },
  };
}
