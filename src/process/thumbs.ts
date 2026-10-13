import { decode } from 'fast-png';
import { rgbaToThumbHash } from 'thumbhash';
import { toBase64 } from '../upload/r2-writer';

export interface Thumbnailer {
  render(
    input: Uint8Array,
    opts: { width?: number; height?: number; format: 'image/webp' | 'image/jpeg' | 'image/png'; quality?: number },
  ): Promise<Uint8Array>;
  /** Raw (pre-orientation) pixel dimensions. */
  info(input: Uint8Array): Promise<{ width: number; height: number }>;
}

export const THUMBNAIL_INPUTS = new Set(['.jpg', '.jpeg', '.jpe', '.jfif', '.png', '.heic', '.heif', '.hif', '.webp', '.gif']);
export const MAX_THUMBNAIL_INPUT = 20 * 1024 * 1024;

export function thumbKey(assetId: string, size: 'thumbnail' | 'preview'): string {
  return size === 'thumbnail' ? `thumbs/${assetId}/thumbnail.webp` : `thumbs/${assetId}/preview.jpeg`;
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}

export function imagesThumbnailer(images: ImagesBinding): Thumbnailer {
  return {
    async render(input, opts) {
      const result = await images
        .input(streamOf(input))
        .transform({ width: opts.width, height: opts.height, fit: 'scale-down' })
        .output({ format: opts.format, quality: opts.quality ?? 80 });
      return new Uint8Array(await result.response().arrayBuffer());
    },
    async info(input) {
      const i = (await images.info(streamOf(input))) as { width?: number; height?: number };
      if (!i.width || !i.height) throw new Error('ERROR 9412: no image dimensions');
      return { width: i.width, height: i.height };
    },
  };
}

export function thumbhashFromPng(png: Uint8Array): string {
  const img = decode(png);
  const { width, height } = img;
  const channels = img.channels;
  const src = img.data as Uint8Array;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = src[i * channels];
    rgba[i * 4 + 1] = src[i * channels + (channels >= 3 ? 1 : 0)];
    rgba[i * 4 + 2] = src[i * channels + (channels >= 3 ? 2 : 0)];
    rgba[i * 4 + 3] = channels === 4 ? src[i * 4 + 3] : channels === 2 ? src[i * 2 + 1] : 255;
  }
  return toBase64(rgbaToThumbHash(width, height, rgba));
}
