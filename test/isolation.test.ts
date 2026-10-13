import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

// Two tests in sequence: the first leaves state behind, the second checks the harness reset it.
describe('per-test isolation', () => {
  it('writes a user row and an R2 object', async () => {
    const now = '2026-01-01T00:00:00.000Z';
    await env.DB.prepare(
      "INSERT INTO users (id, email, name, password_hash, profile_changed_at, created_at, updated_at, update_id) VALUES ('iso1', 'iso@x.y', 'I', 'x', ?1, ?1, ?1, 'c')",
    ).bind(now).run();
    await env.DB.prepare('UPDATE seq SET v = 5 WHERE id = 1').run();
    await env.MEDIA.put('leftover/object.bin', new Uint8Array([1, 2, 3]));
    expect(await env.DB.prepare('SELECT count(*) AS n FROM users').first('n')).toBe(1);
  });

  it('starts with empty D1 tables, seq at 0 and an empty MEDIA bucket', async () => {
    expect(await env.DB.prepare('SELECT count(*) AS n FROM users').first('n')).toBe(0);
    expect(await env.DB.prepare('SELECT v FROM seq WHERE id = 1').first('v')).toBe(0);
    const listed = await env.MEDIA.list();
    expect(listed.objects).toEqual([]);
  });
});
