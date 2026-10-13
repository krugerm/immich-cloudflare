import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { mapAssetResponse } from '../assets/map';
import { requireAuth } from '../auth/session';
import type { AssetRow, ExifRow } from '../db/rows';
import { bad } from '../http/validate';

export const viewRoutes = new Hono<AppEnv>();

const stripTrailingSlash = (p: string) => p.replace(/\/$/, '');
const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);

// Directory of original_path (everything up to the last slash) without the trailing slash, as Immich's view repository does.
viewRoutes.get('/view/folder/unique-paths', requireAuth, async (c) => {
  const { results } = await c.env.DB
    .prepare(
      `SELECT DISTINCT rtrim(original_path, replace(original_path, '/', '')) AS dir FROM assets
       WHERE owner_id = ?1 AND visibility = 'timeline' AND deleted_at IS NULL AND dir <> '' ORDER BY dir`,
    )
    .bind(c.get('auth').user.id)
    .all<{ dir: string }>();
  return c.json(results.map((r) => stripTrailingSlash(r.dir)));
});

// Immich: original_path LIKE %path/% AND NOT LIKE %path/%/%, ordered by file name. That is: `path/` occurs and nothing after its
// first occurrence contains another slash. D1 rejects LIKE patterns over 50 bytes, so this uses instr().
viewRoutes.get('/view/folder', requireAuth, async (c) => {
  const path = c.req.query('path');
  if (path === undefined) bad('path must be a string');
  const needle = `${stripTrailingSlash(path as string)}/`;
  const { results } = await c.env.DB
    .prepare(
      `SELECT * FROM assets WHERE owner_id = ?1 AND visibility = 'timeline' AND deleted_at IS NULL
         AND instr(original_path, ?2) > 0 AND instr(substr(original_path, instr(original_path, ?2) + length(?2)), '/') = 0`,
    )
    .bind(c.get('auth').user.id, needle)
    .all<AssetRow>();
  results.sort((a, b) => (baseName(a.original_path) < baseName(b.original_path) ? -1 : baseName(a.original_path) > baseName(b.original_path) ? 1 : 0));
  const exif = new Map<string, ExifRow>();
  for (let i = 0; i < results.length; i += 90) {
    const ids = results.slice(i, i + 90).map((a) => a.id);
    const { results: ex } = await c.env.DB.prepare(`SELECT * FROM asset_exif WHERE asset_id IN (${ids.map((_, j) => `?${j + 1}`).join(',')})`).bind(...ids).all<ExifRow>();
    for (const e of ex) exif.set(e.asset_id, e);
  }
  return c.json(results.map((a) => mapAssetResponse(a, exif.get(a.id) ?? null)));
});
