// Phase 4: the contract between the Worker and the `ml` container (Immich's machine-learning server). Streams build
// against this file; change it only through the controller.

export const CLIP_MODEL = 'ViT-B-16-SigLIP2__webli';
export const CLIP_DIM = 768;
export const FACE_MODEL = 'buffalo_l';
export const FACE_DIM = 512;

/** A face in the pixel space of the image that was sent (the asset's preview). */
export interface MlFace {
  boundingBox: { x1: number; y1: number; x2: number; y2: number };
  score: number;
  embedding: number[];
}

export interface MlImageResult {
  /** SigLIP2 image embedding (CLIP_DIM), or null when not requested. */
  clip: number[] | null;
  /** Detected faces with buffalo_l embeddings (FACE_DIM), or null when not requested. */
  faces: MlFace[] | null;
  /** Size of the image the boxes refer to. */
  imageWidth: number;
  imageHeight: number;
}

export interface MlClient {
  predict(image: Uint8Array, want: { clip: boolean; faces: boolean }): Promise<MlImageResult>;
  /** SigLIP2 text embedding (CLIP_DIM) for a search query. */
  embedText(text: string): Promise<number[]>;
}

/** The container is down, cold, overloaded or timed out. The queue retries; nothing is marked failed. */
export class MlUnavailableError extends Error {}

/** The image could not be decoded by the ML server. The asset is stamped as processed with no embedding or faces. */
export class MlInputError extends Error {}

/**
 * The ML server failed on an image with FastAPI's bare 500 "Internal Server Error" (an unhandled exception, which is
 * how Pillow decode errors surface in v3.3.1). It may also be a transient fault, so it is retried like
 * MlUnavailableError; only the queue's final attempt stamps the asset as processed (src/ml/job.ts).
 */
export class MlBadImageError extends Error {}

/** Float32 little-endian BLOB for D1. */
export function toBlob(values: number[]): Uint8Array {
  const f = new Float32Array(values);
  return new Uint8Array(f.buffer);
}

export function fromBlob(blob: ArrayBuffer | Uint8Array): number[] {
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  const copy = bytes.slice(); // align for Float32Array
  return Array.from(new Float32Array(copy.buffer, 0, copy.byteLength / 4));
}
