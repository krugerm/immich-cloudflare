// Uploads test/fixtures/media/* to a running `wrangler dev`, the way @immich/cli does.
// Usage: BASE=http://localhost:8787/api node scripts/e2e-upload.mjs
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE ?? 'http://localhost:8787/api';
const DIR = 'test/fixtures/media';
const json = { 'content-type': 'application/json' };

await fetch(`${BASE}/auth/admin-sign-up`, {
  method: 'POST',
  headers: json,
  body: JSON.stringify({ email: 'e2e@example.com', password: 'e2e-pass-123', name: 'E2E' }),
}); // 400 when the admin already exists; ignored

const login = await fetch(`${BASE}/auth/login`, {
  method: 'POST',
  headers: json,
  body: JSON.stringify({ email: 'e2e@example.com', password: 'e2e-pass-123' }),
});
if (login.status !== 201) throw new Error(`login ${login.status}: ${await login.text()}`);
const auth = { 'x-immich-user-token': (await login.json()).accessToken };

const files = readdirSync(DIR).map((name) => {
  const bytes = readFileSync(join(DIR, name));
  return { name, bytes, checksum: createHash('sha1').update(bytes).digest('hex') };
});

const check = await fetch(`${BASE}/assets/bulk-upload-check`, {
  method: 'POST',
  headers: { ...auth, ...json },
  body: JSON.stringify({ assets: files.map((f) => ({ id: f.name, checksum: f.checksum })) }),
});
if (!check.ok) throw new Error(`bulk-upload-check ${check.status}: ${await check.text()}`);
const { results } = await check.json();
let failed = false;
for (const f of files) {
  const verdict = results.find((r) => r.id === f.name);
  if (!verdict) {
    console.log(`${f.name}: no verdict in bulk-upload-check response ${JSON.stringify(results)}`);
    failed = true;
    continue;
  }
  if (verdict.action === 'reject') {
    console.log(`${f.name}: already uploaded as ${verdict.assetId}`);
    continue;
  }
  const form = new FormData();
  form.append('fileCreatedAt', new Date().toISOString());
  form.append('fileModifiedAt', new Date().toISOString());
  form.append('assetData', new Blob([f.bytes]), f.name);
  form.append('visibility', 'timeline');
  const res = await fetch(`${BASE}/assets`, { method: 'POST', headers: auth, body: form });
  const body = await res.text();
  console.log(`${f.name}: ${res.status} ${body}`);
  if (res.status !== 201 && res.status !== 200) failed = true;
}
process.exit(failed ? 1 : 0);
