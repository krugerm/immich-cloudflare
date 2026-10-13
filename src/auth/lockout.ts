// stream A: per-account attempt counters in login_failures, shared by the login and PIN lockouts.
// Keys are namespaced (`login:<email>`, `pin:<userId>`) so one kind of attempt can never address the other's counter.

export const loginKey = (email: string) => `login:${email.toLowerCase()}`;
export const pinKey = (userId: string) => `pin:${userId}`;

/**
 * Reserves one attempt before the secret is verified: a single statement inserts or increments the counter
 * (restarting it when the window has expired) and returns the new count. Returns false when the count is over `max`,
 * so concurrent guesses cannot all pass a check made before any of them was counted. Call `clearAttempts` on success.
 */
export async function reserveAttempt(db: D1Database, key: string, max: number, windowMs: number, now = new Date()): Promise<boolean> {
  const count = await db
    .prepare(
      `INSERT INTO login_failures (email, failures, window_start) VALUES (?1, 1, ?2)
       ON CONFLICT(email) DO UPDATE SET
         failures = CASE WHEN window_start < ?3 THEN 1 ELSE failures + 1 END,
         window_start = CASE WHEN window_start < ?3 THEN ?2 ELSE window_start END
       RETURNING failures`,
    )
    .bind(key, now.toISOString(), new Date(now.getTime() - windowMs).toISOString())
    .first<number>('failures');
  return (count ?? 0) <= max;
}

export async function clearAttempts(db: D1Database, key: string): Promise<void> {
  await db.prepare('DELETE FROM login_failures WHERE email = ?1').bind(key).run();
}
