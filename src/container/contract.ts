// Phase 3: the contract between the Worker and the `media` container. Streams build against this file; change it only
// through the controller.

/** R2 keys the container writes. Purge deletes them with the asset (assetObjectKeys in src/cron/purge.ts). */
export function derivedKey(assetId: string, kind: 'poster' | 'full'): string {
  return `derived/${assetId}/${kind}.jpeg`;
}

/** Subset of `ffprobe -v error -print_format json -show_format -show_streams` output that the Worker reads. */
export interface FfprobeOutput {
  format?: { duration?: string; tags?: Record<string, string> };
  streams?: Array<{
    codec_type?: string;
    width?: number;
    height?: number;
    duration?: string;
    tags?: Record<string, string>;
    side_data_list?: Array<{ side_data_type?: string; rotation?: number }>;
    disposition?: { attached_pic?: number };
  }>;
}

/** `exiftool -json -n` output for one file (a single object, numeric values unformatted). */
export type ExiftoolOutput = Record<string, string | number | undefined>;

/** POST /video {key, posterKey}: probes the video and writes an upright SDR JPEG poster (long edge <= 3840) to posterKey. */
export interface VideoResult {
  ffprobe: FfprobeOutput;
  /** Pixel size of the JPEG written to posterKey (after rotation). */
  poster: { width: number; height: number };
}

/**
 * POST /image {key, outKey}: for RAW files and images the Images binding cannot take (over 20 MB or an unsupported
 * format), writes an upright JPEG to outKey with the long edge <= 4096 px and size < 20 MB, and returns the original's
 * EXIF.
 */
export interface ImageResult {
  exiftool: ExiftoolOutput;
  output: { width: number; height: number };
}

/** The container could not decode the input (HTTP 422). Terminal: the asset becomes `failed`. Other errors are retried. */
export class MediaInputError extends Error {}

export interface MediaProcessor {
  video(key: string, posterKey: string): Promise<VideoResult>;
  image(key: string, outKey: string): Promise<ImageResult>;
}
