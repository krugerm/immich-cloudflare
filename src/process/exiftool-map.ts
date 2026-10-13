import type { ExiftoolOutput } from '../container/contract';
import { coord, exposure, num, rating, str, toUtc, type ExtractedExif } from './exif';
import { formatZone } from './exif';

/** exiftool prints "2024:07:14 18:03:12" (optionally with fractions or a zone suffix); returns the clock time marked UTC, as exifr revives it. */
function clockDate(v: unknown): Date | null {
  const m = typeof v === 'string' ? v.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/) : null;
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  return Number.isNaN(d.getTime()) || +m[1] === 0 ? null : d;
}

/** Maps `exiftool -json -n` output to the shape extractExif produces. width/height are the stored pixel size before orientation. */
export function mapExiftool(out: ExiftoolOutput): ExtractedExif {
  const offset = str(out.OffsetTimeOriginal) ?? str(out.OffsetTime);
  const lat = coord(out.GPSLatitude);
  const lon = coord(out.GPSLongitude);
  const noGps = lat === null || lon === null || (lat === 0 && lon === 0);
  const orientation = num(out.Orientation);
  return {
    make: str(out.Make),
    model: str(out.Model),
    lensModel: str(out.LensModel) ?? str(out.Lens),
    exposureTime: exposure(out.ExposureTime),
    fNumber: num(out.FNumber),
    focalLength: num(out.FocalLength),
    iso: num(out.ISO),
    latitude: noGps ? null : lat,
    longitude: noGps ? null : lon,
    dateTimeOriginal: toUtc(clockDate(out.DateTimeOriginal) ?? clockDate(out.CreateDate), offset),
    timeZone: formatZone(offset),
    orientation: orientation === null ? null : String(orientation),
    rating: rating(out.Rating),
    description: str(out.ImageDescription) ?? '',
    exifImageWidth: num(out.ExifImageWidth) ?? num(out.ImageWidth),
    exifImageHeight: num(out.ExifImageHeight) ?? num(out.ImageHeight),
    profileDescription: str(out.ProfileDescription),
    projectionType: str(out.ProjectionType)?.toUpperCase() ?? null,
    width: num(out.ImageWidth),
    height: num(out.ImageHeight),
  };
}
