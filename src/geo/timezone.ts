import tzLookup from '@photostructure/tz-lookup';

/** IANA zone for a coordinate, or null when the coordinate is invalid. */
export function zoneAt(lat: number, lon: number): string | null {
  try {
    return tzLookup(lat, lon) || null;
  } catch {
    return null;
  }
}

const formats = new Map<string, Intl.DateTimeFormat>();

/** Offset of an IANA zone from UTC, in minutes, at a UTC instant (DST aware). */
export function offsetMinutesAt(zone: string, utcMs: number): number {
  let f = formats.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' });
    formats.set(zone, f);
  }
  const name = f.formatToParts(new Date(utcMs)).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = name.match(/^GMT(?:([+-])(\d{2}):(\d{2}))?$/);
  if (!m || !m[1]) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/** UTC instant (ms) of a wall-clock time (given as ms, clock fields read as UTC) in an IANA zone. Two passes handle DST. */
export function wallToUtc(wallMs: number, zone: string): number {
  const first = wallMs - offsetMinutesAt(zone, wallMs) * 60_000;
  return wallMs - offsetMinutesAt(zone, first) * 60_000;
}
