import exifr from 'exifr';
import { offsetMinutesAt } from '../geo/timezone';

export interface ExtractedExif {
  make: string | null;
  model: string | null;
  lensModel: string | null;
  exposureTime: string | null;
  fNumber: number | null;
  focalLength: number | null;
  iso: number | null;
  latitude: number | null;
  longitude: number | null;
  dateTimeOriginal: string | null;
  timeZone: string | null;
  orientation: string | null;
  rating: number | null;
  description: string;
  exifImageWidth: number | null;
  exifImageHeight: number | null;
  profileDescription: string | null;
  projectionType: string | null;
  width: number | null;
  height: number | null;
  /** Filled by geocoding (src/geo/enrich.ts); absent from the raw extractors. */
  city?: string | null;
  state?: string | null;
  country?: string | null;
}

const EMPTY: ExtractedExif = {
  make: null, model: null, lensModel: null, exposureTime: null, fNumber: null, focalLength: null, iso: null,
  latitude: null, longitude: null, dateTimeOriginal: null, timeZone: null, orientation: null,
  rating: null, description: '', exifImageWidth: null, exifImageHeight: null, profileDescription: null,
  projectionType: null, width: null, height: null,
};

export const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
export const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** Immich keeps six decimals of GPS precision. */
export const coord = (v: unknown) => {
  const n = num(v);
  return n === null ? null : Math.round(n * 1e6) / 1e6;
};
/** Immich stores no rating for 0 or anything outside 1..5. */
export const rating = (v: unknown) => {
  const n = num(v);
  return n !== null && n >= 1 && n <= 5 ? n : null;
};

export function exposure(v: unknown): string | null {
  const n = num(v);
  if (n === null) return null;
  return n >= 1 ? String(n) : `1/${Math.round(1 / n)}`;
}

/** Accepts an EXIF offset ("+02:00") or the stored zone form ("UTC+2", "UTC+5:30", "UTC+0"). */
function offsetMinutes(tz: string | null): number | null {
  const m = tz?.match(/^(?:UTC)?([+-])(\d{1,2})(?::(\d{2}))?$/);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : null;
}

/** Immich stores a fixed-offset zone as "UTC+2" / "UTC+5:30" / "UTC+0", not the raw EXIF "+02:00". */
export function formatZone(offset: string | null): string | null {
  const min = offsetMinutes(offset);
  if (min === null) return null;
  const abs = Math.abs(min);
  const mm = abs % 60;
  return `UTC${min < 0 ? '-' : '+'}${Math.floor(abs / 60)}${mm ? `:${String(mm).padStart(2, '0')}` : ''}`;
}

/**
 * exifr revives EXIF clock strings in the runtime's timezone (UTC in workerd) and ignores OffsetTime*,
 * so the revived instant carries the local clock time. With a known offset, subtract it to get true UTC.
 */
export function toUtc(v: unknown, offset: string | null): string | null {
  if (!(v instanceof Date) || Number.isNaN(v.getTime())) return null;
  const min = offsetMinutes(offset);
  return new Date(v.getTime() - (min ?? 0) * 60_000).toISOString();
}

export async function extractExif(bytes: Uint8Array): Promise<ExtractedExif> {
  let t: Record<string, any> | undefined;
  try {
    t = await exifr.parse(bytes, { tiff: true, exif: true, gps: true, icc: true, xmp: true, iptc: false, translateValues: false, reviveValues: true, mergeOutput: true });
  } catch {
    return { ...EMPTY };
  }
  if (!t) return { ...EMPTY };
  const offset = str(t.OffsetTimeOriginal) ?? str(t.OffsetTime);
  const orientation = num(t.Orientation);
  const w = num(t.ExifImageWidth) ?? num(t.ImageWidth);
  const h = num(t.ExifImageHeight) ?? num(t.ImageHeight);
  const swap = orientation !== null && orientation >= 5;
  return {
    make: str(t.Make),
    model: str(t.Model),
    lensModel: str(t.LensModel),
    exposureTime: exposure(t.ExposureTime),
    fNumber: num(t.FNumber),
    focalLength: num(t.FocalLength),
    iso: num(t.ISO),
    latitude: coord(t.latitude),
    longitude: coord(t.longitude),
    dateTimeOriginal: toUtc(t.DateTimeOriginal ?? t.CreateDate, offset),
    timeZone: formatZone(offset),
    orientation: orientation === null ? null : String(orientation),
    rating: rating(t.Rating),
    description: str(t.ImageDescription) ?? str(t.description) ?? '',
    exifImageWidth: w,
    exifImageHeight: h,
    profileDescription: str(t.ProfileDescription),
    projectionType: str(t.ProjectionType)?.toUpperCase() ?? null,
    width: swap ? h : w,
    height: swap ? w : h,
  };
}

/**
 * Immich stores localDateTime as the local wall-clock time of capture, marked UTC.
 * dateTimeOriginal is true UTC when timeZone (an offset) is known, otherwise the clock time marked UTC.
 */
export function localDateTime(dateTimeOriginal: string | null, timeZone: string | null, fallbackUtc: string): string {
  if (!dateTimeOriginal) return new Date(fallbackUtc).toISOString();
  const utcMs = new Date(dateTimeOriginal).getTime();
  // A fixed offset ("UTC+2") or an IANA name from the GPS lookup ("Europe/Zurich").
  const minutes = offsetMinutes(timeZone) ?? (timeZone ? offsetMinutesAt(timeZone, utcMs) : null);
  if (minutes === null) return new Date(utcMs).toISOString();
  return new Date(utcMs + minutes * 60_000).toISOString();
}
