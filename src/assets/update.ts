import { removeAssetsFromAllAlbums } from '../albums/repo';
import { commit, tracked, type Tracked } from '../db/changes';
import type { AssetRow, ExifRow } from '../db/rows';
import { ImmichError } from '../http/errors';
import { isUuid } from './access';

export const VISIBILITIES = ['archive', 'timeline', 'hidden', 'locked'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export interface AssetPatch {
  isFavorite?: boolean;
  visibility?: Visibility;
  description?: string;
  dateTimeOriginal?: string;
  latitude?: number;
  longitude?: number;
  rating?: number | null;
  dateTimeRelative?: number;
  timeZone?: string;
  /** undefined: leave alone, null: unlink, string: link to this motion video. Single update only. */
  livePhotoVideoId?: string | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

const bad = (message: string) => new ImmichError(400, message);

function num(body: Record<string, unknown>, key: string, min: number, max: number, integer = false): number | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (integer && !Number.isInteger(v))) {
    throw bad(`${key} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`);
  }
  return v;
}

/** Validates the fields shared by PUT /assets/{id} and PUT /assets; unknown keys are ignored like Immich's DTOs. */
export function parsePatch(body: Record<string, unknown>, bulk: boolean): AssetPatch {
  const patch: AssetPatch = {};
  if (body.isFavorite !== undefined) {
    if (typeof body.isFavorite !== 'boolean') throw bad('isFavorite must be a boolean');
    patch.isFavorite = body.isFavorite;
  }
  if (body.visibility !== undefined) {
    if (!VISIBILITIES.includes(body.visibility as Visibility)) throw bad('visibility must be one of archive, timeline, hidden, locked');
    patch.visibility = body.visibility as Visibility;
  }
  if (body.description !== undefined) {
    if (typeof body.description !== 'string') throw bad('description must be a string');
    patch.description = body.description;
  }
  if (body.dateTimeOriginal !== undefined) {
    if (typeof body.dateTimeOriginal !== 'string' || !ISO_DATE.test(body.dateTimeOriginal) || Number.isNaN(Date.parse(withZone(body.dateTimeOriginal)))) {
      throw bad('dateTimeOriginal must be an ISO 8601 date-time');
    }
    patch.dateTimeOriginal = body.dateTimeOriginal;
  }
  patch.latitude = num(body, 'latitude', -90, 90);
  patch.longitude = num(body, 'longitude', -180, 180);
  if (body.rating !== undefined) {
    if (body.rating !== null) patch.rating = num(body, 'rating', -1, 5, true);
    else patch.rating = null;
  }
  if (bulk) {
    patch.dateTimeRelative = num(body, 'dateTimeRelative', -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, true);
    if (body.timeZone !== undefined) {
      if (typeof body.timeZone !== 'string' || !validZone(body.timeZone)) throw bad('timeZone must be an IANA time zone');
      patch.timeZone = body.timeZone;
    }
    if (body.duplicateId !== undefined && body.duplicateId !== null && typeof body.duplicateId !== 'string') throw bad('duplicateId must be a string');
  } else if (body.livePhotoVideoId !== undefined) {
    if (body.livePhotoVideoId !== null && !isUuid(body.livePhotoVideoId)) throw bad('livePhotoVideoId must be a UUID');
    patch.livePhotoVideoId = body.livePhotoVideoId as string | null;
  }
  for (const k of Object.keys(patch) as Array<keyof AssetPatch>) if (patch[k] === undefined) delete patch[k];
  return patch;
}

function withZone(iso: string): string {
  const s = iso.replace(' ', 'T');
  return /(Z|[+-]\d{2}(?::?\d{2})?)$/i.test(s.slice(10)) ? s : `${s}Z`;
}

function validZone(tz: string): boolean {
  if (/^UTC([+-]\d{1,2}(:\d{2})?)?$/.test(tz)) return true;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Offset of a zone from UTC in minutes at an instant; `UTC+2` style fixed zones and IANA names. */
export function zoneOffsetMinutes(tz: string | null, instant: Date): number {
  if (!tz) return 0;
  const fixed = tz.match(/^UTC(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/);
  if (fixed) return fixed[1] ? (fixed[1] === '-' ? -1 : 1) * (Number(fixed[2]) * 60 + Number(fixed[3] ?? 0)) : 0;
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
      })
        .formatToParts(instant)
        .map((p) => [p.type, Number(p.value)]),
    );
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
  } catch {
    return 0;
  }
}

/** Immich's extractTimeZone: only a fixed offset in the string counts; Z is plain UTC. */
function zoneFromIso(iso: string): string | null {
  const m = iso.replace(' ', 'T').slice(10).match(/(Z|([+-])(\d{2})(?::?(\d{2}))?)$/i);
  if (!m) return null;
  if (m[1].toUpperCase() === 'Z') return 'UTC';
  const h = Number(m[3]);
  const min = Number(m[4] ?? 0);
  return `UTC${m[2]}${h}${min ? `:${String(min).padStart(2, '0')}` : ''}`;
}

const EXIF_LOCKABLE = ['dateTimeOriginal', 'timeZone', 'latitude', 'longitude', 'rating', 'description'] as const;
type Lockable = (typeof EXIF_LOCKABLE)[number];

function parseLocked(row: ExifRow | undefined): Lockable[] {
  try {
    const v = row?.locked_properties ? JSON.parse(row.locked_properties) : [];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

const IN_CHUNK = 90;

export async function loadExifRows(db: D1Database, ids: string[]): Promise<Map<string, ExifRow>> {
  const out = new Map<string, ExifRow>();
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    const { results } = await db
      .prepare(`SELECT * FROM asset_exif WHERE asset_id IN (${chunk.map((_, n) => `?${n + 1}`).join(',')})`)
      .bind(...chunk)
      .all<ExifRow>();
    for (const r of results) out.set(r.asset_id, r);
  }
  return out;
}

function exifStatement(asset: AssetRow, existing: ExifRow | undefined, set: Partial<Record<string, unknown>>, locks: Lockable[]): Tracked {
  const merged = [...new Set([...parseLocked(existing), ...locks])];
  const cols = Object.keys(set);
  const names = ['asset_id', 'owner_id', ...cols, 'locked_properties'];
  const binds = [asset.id, asset.owner_id, ...cols.map((k) => set[k]), JSON.stringify(merged)];
  const updates = [...cols, 'locked_properties'].map((c) => `${c} = excluded.${c}`).join(', ');
  return tracked(
    `INSERT INTO asset_exif (${names.join(', ')}, update_id)
     SELECT ${names.map((_, i) => `?${i + 1}`).join(', ')}, :cursor WHERE EXISTS (SELECT 1 FROM assets WHERE id = ?1 AND owner_id = ?2)
     ON CONFLICT (asset_id) DO UPDATE SET ${updates}, update_id = excluded.update_id`,
    ...binds,
  );
}

/** Builds the tracked statements for one asset; one statement per synced row. */
function statementsFor(asset: AssetRow, existing: ExifRow | undefined, patch: AssetPatch, now: string): Tracked[] {
  const out: Tracked[] = [];
  const exifSet: Record<string, unknown> = {};
  const locks: Lockable[] = [];
  if (patch.description !== undefined) {
    exifSet.description = patch.description;
    locks.push('description');
  }
  if (patch.latitude !== undefined) {
    exifSet.latitude = patch.latitude;
    locks.push('latitude');
  }
  if (patch.longitude !== undefined) {
    exifSet.longitude = patch.longitude;
    locks.push('longitude');
  }
  if (patch.rating !== undefined) {
    exifSet.rating = patch.rating;
    locks.push('rating');
  }

  let date = existing?.date_time_original ?? null;
  let zone = existing?.time_zone ?? null;
  let dateTouched = false;
  if (patch.dateTimeOriginal !== undefined) {
    date = new Date(withZone(patch.dateTimeOriginal)).toISOString();
    const z = zoneFromIso(patch.dateTimeOriginal);
    if (z) zone = z;
    dateTouched = true;
  }
  if (patch.dateTimeRelative && date) {
    date = new Date(Date.parse(date) + patch.dateTimeRelative * 60_000).toISOString();
    dateTouched = true;
  }
  if (patch.timeZone !== undefined) {
    zone = patch.timeZone;
    dateTouched = true;
  }
  if (dateTouched) {
    exifSet.date_time_original = date;
    exifSet.time_zone = zone;
    locks.push('dateTimeOriginal', 'timeZone');
  }
  if (Object.keys(exifSet).length > 0) out.push(exifStatement(asset, existing, exifSet, locks));

  const sets: string[] = [];
  const binds: unknown[] = [asset.id, asset.owner_id];
  const add = (column: string, value: unknown) => {
    binds.push(value);
    sets.push(`${column} = ?${binds.length}`);
  };
  if (patch.isFavorite !== undefined && (patch.isFavorite ? 1 : 0) !== asset.is_favorite) add('is_favorite', patch.isFavorite ? 1 : 0);
  if (patch.visibility !== undefined && patch.visibility !== asset.visibility) add('visibility', patch.visibility);
  if (dateTouched && date) {
    const local = new Date(Date.parse(date) + zoneOffsetMinutes(zone, new Date(date)) * 60_000).toISOString();
    if (local !== asset.local_date_time) add('local_date_time', local);
  }
  if (patch.livePhotoVideoId !== undefined && patch.livePhotoVideoId !== asset.live_photo_video_id) add('live_photo_video_id', patch.livePhotoVideoId);
  if (sets.length > 0) {
    binds.push(now);
    out.push(tracked(`UPDATE assets SET ${sets.join(', ')}, updated_at = ?${binds.length}, update_id = :cursor WHERE id = ?1 AND owner_id = ?2`, ...binds));
  }
  return out;
}

function visibilityTouchesLock(patch: AssetPatch, assets: Iterable<AssetRow>): boolean {
  if (patch.visibility === undefined) return false;
  if (patch.visibility === 'locked') return true;
  for (const a of assets) if (a.visibility === 'locked') return true;
  return false;
}

/** Commits groups of statements, never splitting a group: one asset's exif, asset and live-photo rows share a batch. */
async function commitGroups(db: D1Database, groups: Array<Array<Tracked | D1PreparedStatement>>, perCommit = 100): Promise<void> {
  let batch: Array<Tracked | D1PreparedStatement> = [];
  for (const g of groups) {
    if (batch.length > 0 && batch.length + g.length > perCommit) {
      await commit(db, batch);
      batch = [];
    }
    batch.push(...g);
  }
  if (batch.length > 0) await commit(db, batch);
}

/**
 * Applies a validated patch to owned assets. Unlike Immich, moving into or out of the locked folder needs a
 * PIN-elevated session (`elevated`, from allowLocked).
 */
export async function applyPatch(env: Env, assets: Map<string, AssetRow>, patch: AssetPatch, elevated = false): Promise<void> {
  if (!elevated && visibilityTouchesLock(patch, assets.values())) {
    throw new ImmichError(403, 'The locked folder requires an elevated PIN session');
  }
  const now = new Date().toISOString();
  const exif = await loadExifRows(env.DB, [...assets.keys()]);
  const groups = new Map<string, Array<Tracked | D1PreparedStatement>>();
  for (const asset of assets.values()) groups.set(asset.id, statementsFor(asset, exif.get(asset.id), patch, now));

  if (patch.livePhotoVideoId !== undefined) {
    // single-asset path only: link or unlink the motion video and keep its visibility in step
    const [asset] = assets.values();
    const items = groups.get(asset.id)!;
    if (patch.livePhotoVideoId) {
      const video = await env.DB.prepare('SELECT id, type, owner_id, visibility FROM assets WHERE id = ?1')
        .bind(patch.livePhotoVideoId)
        .first<{ id: string; type: string; owner_id: string; visibility: string }>();
      if (!video) throw bad('Live photo video not found');
      if (video.type !== 'VIDEO') throw bad('Live photo video must be a video');
      if (video.owner_id !== asset.owner_id) throw bad('Live photo video does not belong to the user');
      if (video.visibility === 'timeline') {
        items.push(tracked(`UPDATE assets SET visibility = 'hidden', updated_at = ?2, update_id = :cursor WHERE id = ?1 AND owner_id = ?3`, video.id, now, asset.owner_id));
      }
    } else if (asset.live_photo_video_id) {
      const visibility = patch.visibility ?? asset.visibility;
      items.push(tracked(`UPDATE assets SET visibility = ?3, updated_at = ?2, update_id = :cursor WHERE id = ?1 AND owner_id = ?4`, asset.live_photo_video_id, now, visibility, asset.owner_id));
    }
  }
  if (patch.visibility === 'locked') {
    // C1: Immich updateAll → AlbumRepository.removeAssetsFromAll. The removals (audited, thumbnail repointed) run after the
    // asset's own update in the same batch, so a failed batch leaves neither change behind.
    const byOwner = new Map<string, string[]>();
    for (const a of assets.values()) byOwner.set(a.owner_id, [...(byOwner.get(a.owner_id) ?? []), a.id]);
    for (const [ownerId, ids] of byOwner) {
      for (const [id, stmts] of await removeAssetsFromAllAlbums(env.DB, ownerId, ids)) groups.get(id)!.push(...stmts);
    }
  }
  await commitGroups(env.DB, [...groups.values()]);
}

export { bad as badRequest };
