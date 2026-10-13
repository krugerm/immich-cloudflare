import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('schema', () => {
  it('creates all tables and the seq row', async () => {
    const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all<{ name: string }>();
    const names = results.map((r) => r.name);
    for (const t of ['asset_audit', 'asset_exif', 'assets', 'seq', 'sessions', 'sync_checkpoints', 'user_audit', 'users']) {
      expect(names).toContain(t);
    }
    expect(await env.DB.prepare('SELECT v FROM seq WHERE id = 1').first('v')).toBe(0);
  });

  it('enforces one asset per owner and checksum', async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO users (id, email, name, password_hash, profile_changed_at, created_at, updated_at, update_id) VALUES ('u1', 'a@b.c', 'A', 'x', ?1, ?1, ?1, 'c')",
    ).bind(now).run();
    const insert = env.DB.prepare(
      "INSERT INTO assets (id, owner_id, device_asset_id, device_id, type, original_path, original_file_name, checksum, file_created_at, file_modified_at, local_date_time, file_size, created_at, updated_at, update_id) VALUES (?1, 'u1', 'd', 'd', 'IMAGE', 'p', 'f.jpg', 'sum', ?2, ?2, ?2, 1, ?2, ?2, 'c')",
    );
    await insert.bind('a1', now).run();
    await expect(insert.bind('a2', now).run()).rejects.toThrow(/UNIQUE/);
  });
});
