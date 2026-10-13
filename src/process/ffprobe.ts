import type { FfprobeOutput } from '../container/contract';
import { formatZone, type ExtractedExif } from './exif';

type Tags = Record<string, string> | undefined;

/** Case-insensitive tag lookup over several tag bags; first non-empty hit wins. */
function tag(names: string[], ...bags: Tags[]): string | null {
  for (const bag of bags) {
    if (!bag) continue;
    for (const n of names) {
      for (const [k, v] of Object.entries(bag)) {
        if (k.toLowerCase() === n.toLowerCase() && typeof v === 'string' && v.trim()) return v.trim();
      }
    }
  }
  return null;
}

function isoInstant(s: string | null): string | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** `2024-07-14T18:03:12+0300` -> true UTC instant and the offset as `+03:00`. */
function withOffset(s: string | null): { instant: string; offset: string | null } | null {
  if (!s) return null;
  const m = s.match(/^(.*?)(?:([+-])(\d{2}):?(\d{2}))$/);
  const offset = m ? `${m[2]}${m[3]}:${m[4]}` : null;
  const instant = isoInstant(m ? `${m[1]}${offset}` : s);
  return instant ? { instant, offset } : null;
}

/** ISO 6709 `+34.6823+033.0464+012.000/`; (0, 0) means no fix. */
function parseLocation(s: string | null): { latitude: number; longitude: number } | null {
  const m = s?.match(/^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/);
  if (!m) return null;
  const latitude = Math.round(Number(m[1]) * 1e6) / 1e6;
  const longitude = Math.round(Number(m[2]) * 1e6) / 1e6;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || (latitude === 0 && longitude === 0)) return null;
  return { latitude, longitude };
}

export function parseFfprobe(out: FfprobeOutput): {
  exif: ExtractedExif;
  durationMs: number | null;
  width: number | null;
  height: number | null;
} {
  // Skip cover art (attached_pic), as the container does when it picks the stream for the poster.
  const stream = out.streams?.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const fmtTags = out.format?.tags;
  const streamTags = stream?.tags;

  let rotation = stream?.side_data_list?.find((d) => d.side_data_type === 'Display Matrix' && typeof d.rotation === 'number')?.rotation;
  if (rotation === undefined) {
    const r = Number(tag(['rotate'], streamTags));
    rotation = Number.isFinite(r) ? r : 0;
  }
  const swap = Math.abs(rotation) % 180 === 90;
  const w = stream?.width ?? null;
  const h = stream?.height ?? null;
  const width = swap ? h : w;
  const height = swap ? w : h;

  const seconds = parseFloat(out.format?.duration ?? stream?.duration ?? '');
  const durationMs = Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;

  let dateTimeOriginal: string | null = null;
  let timeZone: string | null = null;
  const apple = withOffset(tag(['com.apple.quicktime.creationdate'], fmtTags));
  if (apple) {
    dateTimeOriginal = apple.instant;
    timeZone = formatZone(apple.offset);
  } else {
    dateTimeOriginal = isoInstant(tag(['creation_time'], fmtTags, streamTags));
  }

  const gps = parseLocation(tag(['com.apple.quicktime.location.ISO6709', 'location'], fmtTags));

  return {
    exif: {
      make: tag(['com.apple.quicktime.make', 'make'], fmtTags),
      model: tag(['com.apple.quicktime.model', 'model'], fmtTags),
      lensModel: null,
      exposureTime: null,
      fNumber: null,
      focalLength: null,
      iso: null,
      latitude: gps?.latitude ?? null,
      longitude: gps?.longitude ?? null,
      dateTimeOriginal,
      timeZone,
      orientation: null,
      rating: null,
      description: '',
      exifImageWidth: width,
      exifImageHeight: height,
      profileDescription: null,
      projectionType: null,
      width,
      height,
    },
    durationMs,
    width,
    height,
  };
}
