import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { commit, formatCursor, nowCursor, tracked } from '../src/db/changes';

const now = '2026-01-01T00:00:00.000Z';
const insertUser = (id: string, email: string) =>
  tracked(
    'INSERT INTO users (id, email, name, password_hash, profile_changed_at, created_at, updated_at, update_id) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?5, :cursor)',
    id,
    email,
    'N',
    'x',
    now,
  );

describe('changes', () => {
  it('formats cursors as sortable UUID-shaped strings', () => {
    expect(formatCursor(1)).toBe('00000000-0000-7000-8000-000000000001');
    expect(formatCursor(255) > formatCursor(16)).toBe(true);
  });

  it('each tracked row gets its own cursor, in commit order', async () => {
    await commit(env.DB, [insertUser('u1', 'a@x.y'), insertUser('u2', 'b@x.y')]);
    const rows = await env.DB.prepare('SELECT id, update_id FROM users ORDER BY update_id').all<{ id: string; update_id: string }>();
    expect(rows.results).toEqual([
      { id: 'u1', update_id: formatCursor(1) },
      { id: 'u2', update_id: formatCursor(2) },
    ]);
    expect(await nowCursor(env.DB)).toBe(formatCursor(2));
  });

  it('rolls back rows and cursor when any statement fails', async () => {
    await commit(env.DB, [insertUser('u1', 'a@x.y')]);
    await expect(commit(env.DB, [insertUser('u2', 'b@x.y'), insertUser('u3', 'a@x.y')])).rejects.toThrow();
    expect(await env.DB.prepare('SELECT count(*) AS n FROM users').first('n')).toBe(1);
    expect(await nowCursor(env.DB)).toBe(formatCursor(1));
  });

  it('refuses SQL without :cursor', () => {
    expect(() => tracked('UPDATE users SET name = ?1', 'x')).toThrow(/:cursor/);
  });
});
