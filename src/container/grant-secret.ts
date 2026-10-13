// The HMAC key for the media container's per-job R2 grants. The Worker both signs and verifies the grants (the
// container only passes them back), so the key never leaves Cloudflare. A MEDIA_GRANT_SECRET Worker secret wins;
// without one, a random key is generated on first use and kept in D1, so a fresh deployment needs no setup step.

const STATE_KEY = 'media_grant_secret';
let cached: string | undefined;

export function resetGrantSecretCache(): void {
  cached = undefined;
}

function randomKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(48));
  return btoa(String.fromCharCode(...bytes));
}

export async function mediaGrantSecret(env: Env): Promise<string> {
  if (env.MEDIA_GRANT_SECRET) return env.MEDIA_GRANT_SECRET;
  if (cached) return cached;
  // Two isolates may race on the first use: INSERT OR IGNORE keeps the first key, and both read it back.
  await env.DB.prepare('INSERT OR IGNORE INTO server_state (key, value, updated_at) VALUES (?1, ?2, ?3)')
    .bind(STATE_KEY, JSON.stringify(randomKey()), new Date().toISOString())
    .run();
  const row = await env.DB.prepare('SELECT value FROM server_state WHERE key = ?1').bind(STATE_KEY).first<{ value: string }>();
  if (!row) throw new Error('media grant secret could not be stored');
  cached = JSON.parse(row.value) as string;
  return cached;
}
