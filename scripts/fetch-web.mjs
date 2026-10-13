#!/usr/bin/env node
// Downloads the prebuilt Immich web app (the release asset built by scripts/build-web.sh at the pinned Immich commit)
// into ./public, checking its sha256. Skips when public/index.html exists. `npm run build` runs this, so a fresh clone
// or the Deploy to Cloudflare button needs no Immich build toolchain.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const COMMIT = 'cc7fd67';
const URL = `https://github.com/krugerm/immich-cloudflare/releases/download/web-${COMMIT}/immich-web-${COMMIT}.tar.gz`;
const SHA256 = 'd479d0bfc4bc35f24c411a0cd7119b399caa807bb65d869bb39c3f88f4929445';

const root = resolve(import.meta.dirname, '..');
const out = join(root, 'public');

if (existsSync(join(out, 'index.html'))) {
  console.log('fetch-web: public/index.html exists, skipping');
  process.exit(0);
}

const res = await fetch(URL);
if (!res.ok) throw new Error(`fetch-web: ${URL} answered ${res.status}`);
const bytes = Buffer.from(await res.arrayBuffer());
const digest = createHash('sha256').update(bytes).digest('hex');
if (digest !== SHA256) throw new Error(`fetch-web: sha256 mismatch, expected ${SHA256}, got ${digest}`);

const dir = mkdtempSync(join(tmpdir(), 'immich-web-'));
const archive = join(dir, 'web.tar.gz');
writeFileSync(archive, bytes);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
execFileSync('tar', ['-xzf', archive, '-C', out]);
rmSync(dir, { recursive: true, force: true });
if (!existsSync(join(out, 'index.html'))) throw new Error('fetch-web: archive has no index.html');
console.log(`fetch-web: Immich web app ${COMMIT} unpacked into public/`);
