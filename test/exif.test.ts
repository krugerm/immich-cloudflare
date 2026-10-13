import { describe, expect, it } from 'vitest';
import { extractExif, formatZone, localDateTime } from '../src/process/exif';
import sampleJpg from './fixtures/media/sample.jpg?arraybuffer';
import noExifPng from './fixtures/media/no-exif.png?arraybuffer';

describe('extractExif', () => {
  it('reads camera, date and GPS from the sample JPEG', async () => {
    const e = await extractExif(new Uint8Array(sampleJpg));
    expect(e.make).toBeTruthy();
    expect(e.dateTimeOriginal).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(e.latitude).toBeTypeOf('number');
    expect(e.longitude).toBeTypeOf('number');
    expect(e.width).toBeGreaterThan(0);
  });

  it('returns nulls for a PNG without EXIF', async () => {
    const e = await extractExif(new Uint8Array(noExifPng));
    expect(e.make).toBeNull();
    expect(e.dateTimeOriginal).toBeNull();
  });

  it('matches the reference field conventions: empty description, no zero rating, six-decimal GPS', async () => {
    const e = await extractExif(new Uint8Array(sampleJpg));
    expect(e.description).toBe('');
    expect(e.rating).toBeNull();
    expect(e.latitude).toBe(43.467448);
    expect(e.longitude).toBe(11.885127);
  });

  it('returns nulls for garbage', async () => {
    const e = await extractExif(new Uint8Array([1, 2, 3]));
    expect(e.dateTimeOriginal).toBeNull();
  });
});

describe('formatZone', () => {
  it('formats EXIF offsets the way Immich stores fixed-offset zones', () => {
    expect(formatZone('+02:00')).toBe('UTC+2');
    expect(formatZone('-05:30')).toBe('UTC-5:30');
    expect(formatZone('+00:00')).toBe('UTC+0');
    expect(formatZone('garbage')).toBeNull();
    expect(formatZone(null)).toBeNull();
  });

  it('localDateTime accepts the stored form', () => {
    expect(localDateTime('2024-05-04T09:00:00.000Z', 'UTC+2', '2024-05-04T09:00:00.000Z')).toBe('2024-05-04T11:00:00.000Z');
    expect(localDateTime('2024-05-04T09:00:00.000Z', 'UTC-5:30', '2024-05-04T09:00:00.000Z')).toBe('2024-05-04T03:30:00.000Z');
  });
});

describe('localDateTime', () => {
  it('keeps the local clock time of the capture', () => {
    expect(localDateTime('2024-05-04T09:00:00.000Z', '+02:00', '2024-05-04T09:00:00.000Z')).toBe('2024-05-04T11:00:00.000Z');
  });
  it('uses the clock time of the sample JPEG (no timezone offset)', async () => {
    const e = await extractExif(new Uint8Array(sampleJpg));
    expect(e.timeZone).toBeNull();
    expect(e.dateTimeOriginal).toBe('2008-10-22T16:28:39.000Z');
    expect(localDateTime(e.dateTimeOriginal, e.timeZone, '2020-01-01T00:00:00.000Z')).toBe('2008-10-22T16:28:39.000Z');
    expect(localDateTime(e.dateTimeOriginal, '+02:00', '2020-01-01T00:00:00.000Z')).toBe('2008-10-22T18:28:39.000Z');
  });
  it('falls back to the UTC upload date', () => {
    expect(localDateTime(null, null, '2024-05-04T10:00:00.000Z')).toBe('2024-05-04T10:00:00.000Z');
  });
});
