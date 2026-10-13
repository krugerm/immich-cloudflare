// Runs inside the media image: node --test test/
// Fixtures come from FIXTURES (default /fixtures), produced by scripts/media-fixtures.sh.
// Named server-test.mjs (not *.test.mjs) so the repo's vitest run, which uses the Workers pool, does not collect it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRangeServer } from './range-server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = process.env.FIXTURES ?? '/fixtures';
const MB = 1024 * 1024;

let root;
let rs;
let server;
let base;

async function startServer(mediaBaseUrl, env = {}) {
  const child = spawn(process.execPath, [path.join(here, '..', 'server.mjs')], {
    env: { ...process.env, PORT: '0', MEDIA_BASE_URL: mediaBaseUrl, ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      const m = /listening on (\d+)/.exec(buf);
      if (m) resolve(Number(m[1]));
    });
    child.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
  return { child, url: `http://127.0.0.1:${port}` };
}

async function post(route, body, { url = base, signal } = {}) {
  const res = await fetch(`${url}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
}

/** Command lines of running processes whose arguments contain `needle` (from /proc; procps is not in the image). */
function processesWith(needle) {
  const found = [];
  for (const pid of readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
    let cmd;
    try {
      cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ');
    } catch {
      continue;
    }
    if (cmd.includes(needle)) found.push(`${pid}: ${cmd}`);
  }
  return found;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Writes a buffer to a temp file and returns {width, height} from vipsheader. */
function jpegSize(buf) {
  const f = path.join(root, `probe-${Math.random().toString(36).slice(2)}.jpeg`);
  writeFileSync(f, buf);
  const out = execFileSync('vipsheader', [f], { encoding: 'utf8' });
  const m = /(\d+)x(\d+)/.exec(out);
  rmSync(f);
  return { width: Number(m[1]), height: Number(m[2]) };
}

/** Mean luma (YAVG, 0-255) of a JPEG, from ffmpeg signalstats. */
function meanLuma(buf) {
  const f = path.join(root, `luma-${Math.random().toString(36).slice(2)}.jpeg`);
  writeFileSync(f, buf);
  // metadata=print logs at info level on stderr.
  const { stderr } = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'info', '-i', f, '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-f', 'null', '-'],
    { encoding: 'utf8' },
  );
  rmSync(f);
  return Number(/YAVG=([\d.]+)/.exec(stderr)[1]);
}

before(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'media-test-'));
  for (const f of readdirSync(FIXTURES)) {
    if (statSync(path.join(FIXTURES, f)).isFile()) copyFileSync(path.join(FIXTURES, f), path.join(root, f));
  }
  // A text file with a video extension.
  writeFileSync(path.join(root, 'not-a-video.mov'), 'this is not a video\n'.repeat(100));
  // Demuxers that open further URLs or files, disguised as .mov. Without the whitelists both would play plain.mp4.
  writeFileSync(
    path.join(root, 'playlist.mov'),
    '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\nplain.mp4\n#EXT-X-ENDLIST\n',
  );
  writeFileSync(path.join(root, 'concat.mov'), 'ffconcat version 1.0\nfile plain.mp4\n');
  // Signed key layout the Worker sends: g/<exp>/<sig>/<key>.
  const signed = path.join(root, 'g', '1760000000', 'c2lnLV9h', 'upload', 'u1');
  mkdirSync(signed, { recursive: true });
  copyFileSync(path.join(root, 'plain.mp4'), path.join(signed, 'a 1.mp4'));
  // big.jpg: 8000x6000 RGB noise at Q=100 is well over 20 MB. Generated here so it never enters git.
  const noise = path.join(root, 'noise.v');
  execFileSync('vips', ['gaussnoise', noise, '8000', '6000', '--mean', '128', '--sigma', '60']);
  execFileSync('vips', ['bandjoin', `${noise} ${noise} ${noise}`, path.join(root, 'noise3.v')]);
  execFileSync('vips', ['cast', path.join(root, 'noise3.v'), path.join(root, 'noise3u.v'), 'uchar']);
  execFileSync('vips', ['copy', path.join(root, 'noise3u.v'), `${path.join(root, 'big.jpg')}[Q=100]`]);
  for (const f of ['noise.v', 'noise3.v', 'noise3u.v']) rmSync(path.join(root, f));

  rs = await startRangeServer(root, { maxChunk: 256 * 1024 });
  server = await startServer(rs.url);
  base = server.url;
});

after(async () => {
  server?.child.kill();
  await rs?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

test('GET /health', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');
});

test('/video on moov-at-end HDR HEVC: metadata, tone-mapped poster, Range reads', async () => {
  const key = 'hdr-hevc-moov-end.mov';
  const posterKey = 'derived/a1/poster.jpeg';
  const size = statSync(path.join(root, key)).size;
  const { status, json, text } = await post('/video', { key, posterKey });
  assert.equal(status, 200, text);

  const video = json.ffprobe.streams.find((s) => s.codec_type === 'video');
  assert.ok(video, 'has a video stream');
  assert.equal(video.color_transfer, 'smpte2084');
  const tags = json.ffprobe.format.tags;
  assert.equal(tags['com.apple.quicktime.creationdate'], '2024-07-14T18:03:12+0300');
  assert.equal(tags['com.apple.quicktime.location.ISO6709'], '+34.6823+033.0464+012.000/');

  const poster = rs.out.get(posterKey);
  assert.ok(poster, 'poster written');
  assert.equal(rs.outTypes.get(posterKey), 'image/jpeg');
  assert.deepEqual(json.poster, jpegSize(poster));
  assert.deepEqual(json.poster, { width: 1280, height: 720 });
  const luma = meanLuma(poster);
  assert.ok(luma > 40 && luma < 200, `mean luma ${luma}`);

  const sent = rs.sent.get(key);
  console.log(`range stats: sent ${sent} of ${size} bytes, starts ${rs.starts.get(key).join(',')}, poster luma ${luma}`);
  assert.ok(sent < size * 0.5, `sent ${sent} of ${size} bytes`);
  assert.ok(rs.starts.get(key).some((s) => s > 0), `range starts ${rs.starts.get(key)}`);
});

test('/video on rotated video writes an upright (portrait) poster', async () => {
  const posterKey = 'derived/a2/poster.jpeg';
  const { status, json, text } = await post('/video', { key: 'rotated.mov', posterKey });
  assert.equal(status, 200, text);
  const poster = rs.out.get(posterKey);
  const dims = jpegSize(poster);
  assert.ok(dims.height > dims.width, `poster ${dims.width}x${dims.height}`);
  assert.deepEqual(json.poster, dims);
});

test('/video reads through short 206 responses (origin caps each Range response)', async () => {
  const capped = await startRangeServer(root, { maxChunk: 16 * 1024 });
  const s = await startServer(capped.url);
  try {
    const res = await fetch(`${s.url}/video`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'rotated.mov', posterKey: 'derived/a4/poster.jpeg' }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    const json = await res.json();
    assert.deepEqual(json.poster, jpegSize(capped.out.get('derived/a4/poster.jpeg')));
    assert.ok(capped.starts.get('rotated.mov').length > 4, `starts ${capped.starts.get('rotated.mov')}`);
  } finally {
    s.child.kill();
    await capped.close();
  }
});

test('/video on a video without metadata', async () => {
  const posterKey = 'derived/a3/poster.jpeg';
  const { status, json, text } = await post('/video', { key: 'plain.mp4', posterKey });
  assert.equal(status, 200, text);
  assert.deepEqual(json.poster, { width: 640, height: 360 });
  assert.ok(Number(json.ffprobe.format.duration) > 1.5);
});

test('/image on a DNG without a usable preview decodes with dcraw_emu', async () => {
  const outKey = 'derived/b0/full.jpeg';
  const { status, json, text } = await post('/image', { key: 'canon-5d3-mlv-nopreview.dng', outKey });
  assert.equal(status, 200, text);
  assert.equal(json.exiftool.Make, 'Canon');
  assert.deepEqual(json.output, { width: 1920, height: 818 });
  assert.deepEqual(jpegSize(rs.out.get(outKey)), json.output);
});

test('/image on a DNG returns EXIF and a JPEG under the limits', async () => {
  const dng = 'canon-5d3-adobe-lossy.dng';
  const outKey = 'derived/b1/full.jpeg';
  const { status, json, text } = await post('/image', { key: dng, outKey });
  assert.equal(status, 200, text);
  assert.ok(json.exiftool.Make, 'exiftool Make');
  const out = rs.out.get(outKey);
  assert.ok(out.length < 20 * MB);
  const dims = jpegSize(out);
  assert.deepEqual(json.output, dims);
  assert.ok(Math.max(dims.width, dims.height) <= 4096);
  assert.ok(Math.max(dims.width, dims.height) >= 1000, `decoded ${dims.width}x${dims.height}`);
});

test('/image on a JPEG over 20 MB writes a JPEG under 20 MB', async () => {
  assert.ok(statSync(path.join(root, 'big.jpg')).size > 20 * MB, 'big.jpg is over 20 MB');
  const outKey = 'derived/b2/full.jpeg';
  const { status, json, text } = await post('/image', { key: 'big.jpg', outKey });
  assert.equal(status, 200, text);
  const out = rs.out.get(outKey);
  assert.ok(out.length < 20 * MB, `${out.length} bytes`);
  assert.deepEqual(json.output, { width: 4096, height: 3072 });
  assert.equal(typeof json.exiftool, 'object');
});

test('/video on a text file renamed .mov returns 422', async () => {
  const { status, json } = await post('/video', { key: 'not-a-video.mov', posterKey: 'derived/c1/poster.jpeg' });
  assert.equal(status, 422);
  assert.equal(typeof json.error, 'string');
  assert.ok(!rs.out.has('derived/c1/poster.jpeg'));
});

test('/image on a text file renamed .jpg returns 422', async () => {
  writeFileSync(path.join(root, 'not-an-image.jpg'), 'nope\n'.repeat(50));
  const { status } = await post('/image', { key: 'not-an-image.jpg', outKey: 'derived/c2/full.jpeg' });
  assert.equal(status, 422);
});

test('missing original returns 502 (retryable)', async () => {
  const v = await post('/video', { key: 'missing.mov', posterKey: 'derived/d1/poster.jpeg' });
  assert.equal(v.status, 502, v.text);
  const i = await post('/image', { key: 'missing.jpg', outKey: 'derived/d2/full.jpeg' });
  assert.equal(i.status, 502, i.text);
});

test('origin 5xx returns 502', async () => {
  const failing = await startRangeServer(root, { failWith: 503 });
  const s = await startServer(failing.url);
  try {
    const res = await fetch(`${s.url}/video`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'plain.mp4', posterKey: 'derived/d3/poster.jpeg' }),
    });
    assert.equal(res.status, 502);
  } finally {
    s.child.kill();
    await failing.close();
  }
});

test('rejects path traversal and bad bodies with 400', async () => {
  assert.equal((await post('/video', { key: '../etc/passwd', posterKey: 'x' })).status, 400);
  assert.equal((await post('/image', { key: '/etc/passwd', outKey: 'x' })).status, 400);
  assert.equal((await post('/image', { key: 'big.jpg', outKey: 'a/../../b' })).status, 400);
  assert.equal((await post('/video', { key: 'plain.mp4' })).status, 400);
  const res = await fetch(`${base}/video`, { method: 'POST', body: '{not json' });
  assert.equal(res.status, 400);
});

test('unknown route returns 404', async () => {
  assert.equal((await fetch(`${base}/nope`)).status, 404);
});

test('signed key layout g/<exp>/<sig>/<key> is fetched as a path', async () => {
  const key = 'g/1760000000/c2lnLV9h/upload/u1/a 1.mp4';
  const { status, json, text } = await post('/video', { key, posterKey: 'derived/e1/poster.jpeg' });
  assert.equal(status, 200, text);
  assert.deepEqual(json.poster, { width: 640, height: 360 });
});

test('HLS playlist and ffconcat files served as .mov are refused with 422', async () => {
  const startsBefore = rs.starts.get('plain.mp4')?.length ?? 0;
  for (const key of ['playlist.mov', 'concat.mov']) {
    const { status, json } = await post('/video', { key, posterKey: `derived/f-${key}/poster.jpeg` });
    assert.equal(status, 422, `${key}: ${json?.error}`);
    // ffmpeg 7.1 already refuses HLS behind a non-.m3u8 extension; the format whitelist refuses concat.
    assert.match(json.error, /whitelist|non standard extension/i, key);
  }
  // Only the disguised file itself was requested; the referenced plain.mp4 was never opened.
  assert.equal(rs.starts.get('plain.mp4')?.length ?? 0, startsBefore);
});

test('deadline: a stuck job returns 504 within the deadline and leaves no child process', async () => {
  const s = await startServer(rs.url, { MEDIA_JOB_DEADLINE_MS: '2000' });
  try {
    for (const [route, body] of [
      ['/video', { key: 'stall/plain.mp4', posterKey: 'derived/g1/poster.jpeg' }],
      ['/image', { key: 'stall/canon-5d3-adobe-lossy.dng', outKey: 'derived/g2/full.jpeg' }],
    ]) {
      const t0 = Date.now();
      const { status, text } = await post(route, body, { url: s.url });
      const elapsed = Date.now() - t0;
      assert.equal(status, 504, `${route}: ${text}`);
      assert.ok(elapsed >= 1900 && elapsed < 4000, `${route} answered after ${elapsed} ms`);
    }
    await sleep(300);
    assert.deepEqual(processesWith('stall/'), []);
  } finally {
    s.child.kill();
  }
});

test('deadline: a request still queued at the deadline returns 503', async () => {
  const s = await startServer(rs.url, { MEDIA_JOB_DEADLINE_MS: '2000' });
  try {
    const results = await Promise.all(
      ['a', 'b', 'c'].map((n, i) =>
        sleep(i * 100).then(() => post('/video', { key: 'stall/plain.mp4', posterKey: `derived/h${n}/poster.jpeg` }, { url: s.url })),
      ),
    );
    assert.deepEqual(
      results.map((r) => r.status),
      [504, 504, 503],
    );
    await sleep(300);
    assert.deepEqual(processesWith('stall/'), []);
  } finally {
    s.child.kill();
  }
});

test('client disconnect kills the job and frees its slot for the next queued job', async () => {
  const s = await startServer(rs.url, { MEDIA_JOB_DEADLINE_MS: '60000' });
  try {
    const clients = [new AbortController(), new AbortController()];
    const stuck = clients.map((c, i) =>
      post('/video', { key: 'stall/plain.mp4', posterKey: `derived/i${i}/poster.jpeg` }, { url: s.url, signal: c.signal }).catch(
        (e) => e.name,
      ),
    );
    await sleep(500);
    assert.equal(processesWith('stall/').length, 2, 'both slots busy');
    const t0 = Date.now();
    const queued = post('/video', { key: 'plain.mp4', posterKey: 'derived/i2/poster.jpeg' }, { url: s.url });
    await sleep(500);
    for (const c of clients) c.abort();
    const r = await queued;
    assert.equal(r.status, 200, r.text);
    assert.ok(Date.now() - t0 < 15000, `queued job finished after ${Date.now() - t0} ms`);
    assert.deepEqual(await Promise.all(stuck), ['AbortError', 'AbortError']);
    await sleep(300);
    assert.deepEqual(processesWith('stall/'), []);
  } finally {
    s.child.kill();
  }
});

test('decoder memory cap fails the job with a retryable 500, and the server keeps running', async () => {
  const s = await startServer(rs.url, { MEDIA_DECODE_MEM_BYTES: String(64 * MB) });
  try {
    const raw = await post('/image', { key: 'canon-5d3-mlv-nopreview.dng', outKey: 'derived/j1/full.jpeg' }, { url: s.url });
    assert.equal(raw.status, 500, raw.text);
    const big = await post('/image', { key: 'big.jpg', outKey: 'derived/j2/full.jpeg' }, { url: s.url });
    assert.equal(big.status, 500, big.text);
    assert.equal((await fetch(`${s.url}/health`)).status, 200);
  } finally {
    s.child.kill();
  }
});
