import defaults from '../defaults/user-preferences.json';
import type { Dto } from '../gen/dto';

// Port of immich server/src/utils/preferences.ts. users.preferences stores only the values that differ from the defaults.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function leafPaths(o: Obj, prefix: string[] = []): string[][] {
  return Object.entries(o).flatMap(([k, v]) => (isObj(v) ? leafPaths(v, [...prefix, k]) : [[...prefix, k]]));
}

function getPath(o: unknown, path: string[]): unknown {
  return path.reduce<unknown>((cur, k) => (isObj(cur) ? cur[k] : undefined), o);
}

function setPath(o: Obj, path: string[], value: unknown): void {
  let cur = o;
  for (const k of path.slice(0, -1)) {
    if (!isObj(cur[k])) cur[k] = {};
    cur = cur[k] as Obj;
  }
  cur[path[path.length - 1]] = value;
}

/** Defaults overlaid with the stored partial. */
export function getPreferences(stored: string | null): Dto<'UserPreferencesResponseDto'> {
  const prefs = structuredClone(defaults) as Obj;
  let partial: unknown = {};
  try {
    partial = JSON.parse(stored || '{}');
  } catch {
    // a malformed stored value falls back to the defaults
  }
  if (isObj(partial)) for (const p of leafPaths(partial)) setPath(prefs, p, getPath(partial, p));
  return prefs as Dto<'UserPreferencesResponseDto'>;
}

/** Applies every leaf of the update DTO. */
export function mergePreferences(prefs: Dto<'UserPreferencesResponseDto'>, dto: Dto<'UserPreferencesUpdateDto'>): Dto<'UserPreferencesResponseDto'> {
  const out = structuredClone(prefs) as Obj;
  for (const p of leafPaths(dto as Obj)) setPath(out, p, getPath(dto, p));
  return out as Dto<'UserPreferencesResponseDto'>;
}

/** The values that differ from the defaults, limited to keys the defaults have (so `avatar` is dropped, as in Immich). */
export function preferencesPartial(prefs: Dto<'UserPreferencesResponseDto'>): Obj {
  const partial: Obj = {};
  for (const p of leafPaths(defaults as Obj)) {
    const value = getPath(prefs, p);
    if (value === undefined || value === null || value === '' || value === getPath(defaults, p)) continue;
    setPath(partial, p, value);
  }
  return partial;
}

export function updatedPreferences(stored: string | null, dto: Dto<'UserPreferencesUpdateDto'>) {
  const prefs = mergePreferences(getPreferences(stored), dto);
  return { prefs, stored: JSON.stringify(preferencesPartial(prefs)) };
}
