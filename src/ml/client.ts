import { getRandom } from '@cloudflare/containers';
import { SEARCH_INSTANCE } from './warm';
import {
  CLIP_DIM,
  CLIP_MODEL,
  FACE_DIM,
  FACE_MODEL,
  MlBadImageError,
  MlInputError,
  MlUnavailableError,
  type MlClient,
  type MlFace,
  type MlImageResult,
} from './contract';

// Image jobs spread over the two instances (max_instances of the MlContainer in wrangler.jsonc). Text search always
// goes to the instance named SEARCH_INSTANCE of the search container, so interactive queries keep hitting a warm one.
const INSTANCES = 2;
/** Covers a cold start (port wait up to 120 s happens inside the container DO, but most starts take 25 to 42 s). */
export const ML_TIMEOUT_MS = 90_000;
// FastAPI's body for an unhandled exception; v3.3.1 answers undecodable images with it.
const BARE_500 = 'Internal Server Error';
// Immich's default machineLearning.facialRecognition.minScore.
const FACE_MIN_SCORE = 0.7;

type Namespace = Env['ML_CONTAINER'];

// Request entries, keyed as in Immich's machine-learning.repository.ts (ModelTask.SEARCH = 'clip',
// ModelTask.FACIAL_RECOGNITION = 'facial-recognition'). Immich sends clip and faces as two requests; the ML server's
// pipeline accepts both tasks in one `entries` object, so one call per asset decodes the image once.
const CLIP_VISUAL = { visual: { modelName: CLIP_MODEL } };
const FACES = {
  detection: { modelName: FACE_MODEL, options: { minScore: FACE_MIN_SCORE } },
  recognition: { modelName: FACE_MODEL },
};

/** Immich's response face: the embedding is a JSON array string (orjson of a numpy array). */
interface WireFace {
  boundingBox: { x1: number; y1: number; x2: number; y2: number };
  score: number;
  embedding: string | number[];
}

interface WireResponse {
  clip?: string | number[];
  'facial-recognition'?: WireFace[];
  imageWidth?: number;
  imageHeight?: number;
}

function vector(raw: unknown, dim: number, what: string): number[] {
  const values = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  if (!Array.isArray(values) || !values.every((v) => typeof v === 'number')) {
    throw new MlUnavailableError(`ml container: ${what} embedding is not a number array`);
  }
  if (values.length !== dim) {
    // A different model answered (misconfigured image): retrying later is right, marking the input bad is not.
    throw new MlUnavailableError(`ml container: ${what} embedding has ${values.length} values, expected ${dim}`);
  }
  return values as number[];
}

function detail(text: string): string {
  try {
    const parsed = JSON.parse(text) as { detail?: unknown };
    if (typeof parsed.detail === 'string') return parsed.detail;
  } catch {
    // Plain-text body: use it as the message.
  }
  return text;
}

async function predict(
  stub: () => Promise<{ fetch: (url: string, init?: RequestInit) => Promise<Response> }>,
  entries: object,
  input: { image: Uint8Array } | { text: string },
): Promise<WireResponse> {
  // Same multipart fields as Immich's getFormData: `entries` JSON, then `image` (a Blob) or `text`.
  const body = new FormData();
  body.append('entries', JSON.stringify(entries));
  if ('image' in input) body.append('image', new Blob([input.image]));
  else body.append('text', input.text);

  let res: Response;
  let text: string;
  try {
    const target = await stub();
    res = await target.fetch('http://container/predict', { method: 'POST', body, signal: AbortSignal.timeout(ML_TIMEOUT_MS) });
    text = await res.text();
  } catch (e) {
    const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new MlUnavailableError(`ml container ${timeout ? 'timeout' : 'error'}: ${e instanceof Error ? e.message : String(e)}`);
  }
  // 400: undecodable or empty image ("Image has zero width or height"); 422: request the server cannot use.
  if (res.status === 400 || res.status === 422) throw new MlInputError(`ml container ${res.status}: ${detail(text)}`);
  // Only the bare body: the containers wrapper ("Failed to start container: ...") and Immich's own HTTPException(500)
  // ({"detail": "Failed to load model ..."}) are infrastructure faults.
  if (res.status === 500 && 'image' in input && text === BARE_500) throw new MlBadImageError(`ml container 500: ${text}`);
  if (res.status !== 200) throw new MlUnavailableError(`ml container ${res.status}: ${text.slice(0, 500)}`);
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as WireResponse;
  } catch {
    // Fall through.
  }
  throw new MlUnavailableError(`ml container: response is not JSON: ${text.slice(0, 200)}`);
}

function faces(raw: unknown): MlFace[] {
  if (!Array.isArray(raw)) throw new MlUnavailableError('ml container: facial-recognition result is missing');
  return (raw as WireFace[]).map((f) => ({
    boundingBox: { x1: f.boundingBox.x1, y1: f.boundingBox.y1, x2: f.boundingBox.x2, y2: f.boundingBox.y2 },
    score: f.score,
    embedding: vector(f.embedding, FACE_DIM, 'face'),
  }));
}

/** An MlClient backed by the ML_CONTAINER binding (Immich's machine-learning server), or undefined without one. */
export function mlClient(env: Env): MlClient | undefined {
  // Optional at runtime: tests and deployments without the container pass an env without it.
  const ns = env.ML_CONTAINER as Namespace | undefined;
  if (!ns) return undefined;
  return {
    async predict(image, want): Promise<MlImageResult> {
      if (!want.clip && !want.faces) return { clip: null, faces: null, imageWidth: 0, imageHeight: 0 };
      const entries = {
        ...(want.clip ? { clip: CLIP_VISUAL } : {}),
        ...(want.faces ? { 'facial-recognition': FACES } : {}),
      };
      const res = await predict(() => getRandom(ns, INSTANCES), entries, { image });
      return {
        clip: want.clip ? vector(res.clip, CLIP_DIM, 'clip') : null,
        faces: want.faces ? faces(res['facial-recognition']) : null,
        imageWidth: Number(res.imageWidth ?? 0),
        imageHeight: Number(res.imageHeight ?? 0),
      };
    },
    async embedText(text) {
      // encodeText sends options: { language }; Immich's language only affects NLLB models, so none is sent.
      // Queries go to the text-only search container when it is bound, else to a named instance of the full one.
      const searchNs = (env.ML_SEARCH as Env['ML_SEARCH'] | undefined) ?? ns;
      const search = async () => searchNs.get(searchNs.idFromName(SEARCH_INSTANCE));
      const res = await predict(search, { clip: { textual: { modelName: CLIP_MODEL, options: {} } } }, { text });
      return vector(res.clip, CLIP_DIM, 'clip');
    },
  };
}
