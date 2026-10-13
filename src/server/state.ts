// stream F: small key/value store for server-wide state (license, memory generation state, queue flags).
export async function getState<T>(db: D1Database, key: string): Promise<T | null> {
  const row = await db.prepare('SELECT value FROM server_state WHERE key = ?1').bind(key).first<{ value: string }>();
  return row ? (JSON.parse(row.value) as T) : null;
}

export async function setState(db: D1Database, key: string, value: unknown): Promise<void> {
  await db
    .prepare('INSERT INTO server_state (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .bind(key, JSON.stringify(value), new Date().toISOString())
    .run();
}

export async function deleteState(db: D1Database, key: string): Promise<void> {
  await db.prepare('DELETE FROM server_state WHERE key = ?1').bind(key).run();
}
