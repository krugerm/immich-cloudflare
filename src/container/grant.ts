// Per-job grants for the media container's R2 access. The queue consumer signs each key it hands to the container;
// the `media.r2` outbound handler serves only signed keys, for the signed method, until the grant expires. A container
// compromised by a crafted upload can then reach only the files of the job it was given.

const GRANT_MS = 3 * 60_000;
const PREFIX = 'g/';

type Access = 'read' | 'write';

async function sign(secret: string, access: Access, exp: number, key: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(`${access}|${exp}|${key}`)));
  return btoa(String.fromCharCode(...mac)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Wraps `key` as `g/<exp>/<sig>/<key>`, valid for `access` until now + 3 minutes. */
export async function grantKey(secret: string, access: Access, key: string, now = Date.now()): Promise<string> {
  const exp = now + GRANT_MS;
  return `${PREFIX}${exp}/${await sign(secret, access, exp, key)}/${key}`;
}

/** The inner key when `wrapped` is an unexpired grant for `access`, else null. */
export async function verifyGrant(secret: string, access: Access, wrapped: string, now = Date.now()): Promise<string | null> {
  const m = /^g\/(\d{1,15})\/([A-Za-z0-9_-]{43})\/(.+)$/.exec(wrapped);
  if (!m) return null;
  const exp = Number(m[1]);
  if (exp < now) return null;
  const expected = await sign(secret, access, exp, m[3]);
  // Constant-time comparison of equal-length ASCII strings.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ m[2].charCodeAt(i);
  return diff === 0 ? m[3] : null;
}
