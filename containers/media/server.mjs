// Media container: probes videos and writes JPEG posters, decodes RAW and large images to JPEG.
// Contract: src/container/contract.ts in the Worker repo. Originals are read from, and results written to,
// MEDIA_BASE_URL/<key> (the Worker's outbound handler backed by R2, with HTTP Range support).
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const BASE = (process.env.MEDIA_BASE_URL ?? 'http://media.r2').replace(/\/+$/, '');
const PORT = Number(process.env.PORT ?? 8080);
const MAX_JOBS = 2;
// One deadline per request, counted from arrival. The Worker client aborts at 120 s.
const JOB_DEADLINE_MS = Number(process.env.MEDIA_JOB_DEADLINE_MS ?? 110_000);
// A queued job starts only if at least this much of its deadline is left; otherwise 503 (retryable).
const MIN_JOB_MS = Math.min(10_000, JOB_DEADLINE_MS / 4);
// Address-space limit for the decoders (dcraw_emu, vipsthumbnail), so two large RAW decodes on a 4 GiB instance fail
// one job instead of getting the server OOM-killed.
const DECODE_MEM_BYTES = Number(process.env.MEDIA_DECODE_MEM_BYTES ?? 1536 * 1024 * 1024);
const JPEG_LIMIT = 20 * 1024 * 1024;
const MIN_PREVIEW_EDGE = 1440;
// ffmpeg http input: keep-alive between the Range requests a seek makes. ffmpeg 7.1 (Debian trixie) has no
// -initial_request_size/-request_size; every request is open-ended (bytes=N-) and ffmpeg closes it when it seeks.
// The whitelists keep ffmpeg to plain HTTP and to demuxers for the Worker's video extensions (src/upload/media-types.ts):
// a playlist (hls) or concat file renamed to .mov cannot make ffmpeg open other URLs or local files.
//   mov: .mov .mp4 .m4v .3gp .3gpp .insv   matroska: .mkv .webm   avi: .avi   flv: .flv   asf: .wmv   mxf: .mxf
//   mpegts: .ts .mts .m2t .m2ts             mpeg (program stream): .mpg .mpeg .mpe .vob
const HTTP_INPUT_OPTS = [
  '-protocol_whitelist', 'http,tcp',
  '-format_whitelist', 'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,mpegts,mpeg,flv,asf,mxf',
  '-multiple_requests', '1',
];
const TONEMAP =
  'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';
const POSTER_SCALE = "scale='min(3840,iw)':'min(3840,ih)':force_original_aspect_ratio=decrease";
const RAW_EXTS = new Set(
  '.dng .cr2 .cr3 .nef .arw .raf .orf .rw2 .pef .srw .x3f .3fr .iiq .erf .kdc .dcr .mrw .nrw .rwl .sr2 .srf'.split(' '),
);
// glibc creates up to 8 malloc arenas per core, each reserving 64 MB of address space; under prlimit --as that
// reservation alone would fail a decode on a many-core host.
const CHILD_ENV = { ...process.env, MALLOC_ARENA_MAX: '2' };

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** The origin (R2 handler) failed or returned a non-2xx status: retryable, 502. */
class OriginError extends Error {}

class ToolError extends Error {
  constructor(tool, code, stderr) {
    super(`${tool} exited ${code}: ${firstLine(stderr)}`);
    this.tool = tool;
    this.stderr = stderr;
  }
}

function firstLine(s) {
  return (
    String(s ?? '')
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? ''
  );
}

const ORIGIN_PATTERN = /Server returned|Connection refused|Connection reset|Connection timed out|Failed to resolve/i;
// Allocation failures (usually the prlimit cap) are retryable, never "undecodable input".
const MEMORY_PATTERN = /out of memory|Cannot allocate memory|unable to allocate|bad_alloc|memory allocation/i;
const INPUT_PATTERN =
  /Invalid data|moov atom not found|unsupported|not on (the )?(format )?whitelist|not a known file format|VipsForeignLoad|VipsJpeg|VipsPng|VipsTiff|vips_image_new_from_file/i;

/** Maps an error to [status, message]. */
export function classify(err) {
  if (err instanceof HttpError) return [err.status, err.message];
  if (err instanceof OriginError) return [502, err.message];
  if (err instanceof ToolError) {
    if (ORIGIN_PATTERN.test(err.stderr)) return [502, firstLine(err.stderr)];
    if (MEMORY_PATTERN.test(err.stderr)) return [500, firstLine(err.stderr)];
    if (INPUT_PATTERN.test(err.stderr)) return [422, firstLine(err.stderr)];
  }
  return [500, err?.message ?? String(err)];
}

/** Rejects with the signal's reason (an HttpError for the deadline, see handleRequest). */
function throwIfAborted(signal) {
  if (signal.aborted) throw signal.reason;
}

/**
 * Runs a tool without a shell. Resolves {stdout: Buffer, stderr: string}; rejects with ToolError on non-zero exit.
 * Aborting `signal` kills the process. `memLimit` runs it under `prlimit --as`.
 */
function run(cmd, args, { signal, allowFail = false, stdoutFile, memLimit } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const [file, argv] = memLimit ? ['prlimit', [`--as=${memLimit}`, '--', cmd, ...args]] : [cmd, args];
    const child = spawn(file, argv, { stdio: ['ignore', 'pipe', 'pipe'], env: CHILD_ENV });
    const out = [];
    let err = '';
    let failure;
    const fail = (e) => {
      failure ??= e;
      child.kill('SIGKILL');
    };
    const onAbort = () => fail(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    const sink = stdoutFile ? createWriteStream(stdoutFile) : null;
    if (sink) {
      // ENOSPC and friends: fail this job, never crash the server with an unhandled 'error'.
      sink.on('error', fail);
      child.stdout.pipe(sink);
    } else {
      child.stdout.on('data', (c) => out.push(c));
    }
    child.stderr.on('data', (c) => {
      if (err.length < 64 * 1024) err += c;
    });
    child.on('error', fail);
    child.on('close', (code, sig) => {
      signal?.removeEventListener('abort', onAbort);
      const finish = () => {
        if (failure) return reject(failure);
        if (sig) return reject(new ToolError(cmd, sig, err || `killed by ${sig}`));
        if (code !== 0 && !allowFail) return reject(new ToolError(cmd, code, err));
        resolve({ code, stdout: Buffer.concat(out), stderr: err });
      };
      // pipe() ends the sink when stdout ends; wait until the file is flushed and closed.
      if (sink && !sink.closed) {
        sink.once('close', finish);
      } else {
        finish();
      }
    });
  });
}

function validKey(k) {
  return typeof k === 'string' && k.length > 0 && k.length <= 1024 && !k.includes('..') && !k.startsWith('/') && !/[\0\\]/.test(k);
}

function keyUrl(key) {
  return `${BASE}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

/** {width, height} of an image file from vipsheader. */
async function imageSize(file, signal) {
  const { stdout } = await run('vipsheader', [file], { signal });
  const m = /: (\d+)x(\d+) /.exec(stdout.toString());
  if (!m) throw new Error(`vipsheader: unexpected output ${stdout}`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

async function putObject(key, body, signal) {
  let res;
  try {
    res = await fetch(keyUrl(key), { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body, signal });
  } catch (e) {
    throwIfAborted(signal);
    throw new OriginError(`PUT ${key}: ${e.message}`);
  }
  if (!res.ok) throw new OriginError(`PUT ${key}: HTTP ${res.status}`);
}

async function download(key, file, signal) {
  let res;
  try {
    res = await fetch(keyUrl(key), { signal });
  } catch (e) {
    throwIfAborted(signal);
    throw new OriginError(`GET ${key}: ${e.message}`);
  }
  if (!res.ok || !res.body) throw new OriginError(`GET ${key}: HTTP ${res.status}`);
  try {
    await pipeline(Readable.fromWeb(res.body), createWriteStream(file), { signal });
  } catch (e) {
    throwIfAborted(signal);
    if (e.code === 'ENOSPC') throw e;
    throw new OriginError(`GET ${key}: ${e.message}`);
  }
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'media-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function poster(url, t, filter, signal) {
  const { stdout } = await run(
    'ffmpeg',
    [
      '-hide_banner', '-v', 'error', ...HTTP_INPUT_OPTS,
      // Decode only the keyframe at or before t, single-threaded: frame threads would read and decode a frame per thread
      // ahead of the first output (standard-1 has half a vCPU, so they buy nothing).
      '-threads', '1', '-skip_frame', 'nokey', '-noaccurate_seek',
      '-ss', String(t), '-i', url,
      // The mjpeg encoder takes full-range YUV only; yuvj420p makes ffmpeg convert the range after the filter chain.
      '-frames:v', '1', '-vf', filter, '-pix_fmt', 'yuvj420p', '-q:v', '3', '-f', 'mjpeg', 'pipe:1',
    ],
    { signal },
  );
  return stdout;
}

export async function handleVideo({ key, posterKey }, signal) {
  const url = keyUrl(key);
  const probe = await run(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', ...HTTP_INPUT_OPTS, url],
    { signal },
  );
  const ffprobe = JSON.parse(probe.stdout.toString() || '{}');
  const video = (ffprobe.streams ?? []).find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!video) throw new HttpError(422, 'no video stream');

  const duration = Number(ffprobe.format?.duration ?? video.duration ?? 0);
  const t = Number.isFinite(duration) && duration > 0 ? Math.min(1, duration / 2) : 0;
  const hdr = video.color_transfer === 'smpte2084' || video.color_transfer === 'arib-std-b67';
  const filter = hdr ? `${TONEMAP},${POSTER_SCALE}` : POSTER_SCALE;

  let jpeg = await poster(url, t, filter, signal);
  if (jpeg.length === 0 && t > 0) jpeg = await poster(url, 0, filter, signal);
  if (jpeg.length === 0) throw new HttpError(422, 'no frame decoded');

  const size = await withTempDir(async (dir) => {
    const f = path.join(dir, 'poster.jpeg');
    await writeFile(f, jpeg);
    return imageSize(f, signal);
  });
  await putObject(posterKey, jpeg, signal);
  return { ffprobe, poster: size };
}

function safeExt(key) {
  const ext = path.extname(key).toLowerCase();
  return /^\.[a-z0-9]{1,5}$/.test(ext) ? ext : '';
}

/** Largest embedded JPEG preview of a RAW file, or null. Upright via the RAW's Orientation tag. */
async function embeddedPreview(dir, input, orientation, signal) {
  for (const tag of ['-JpgFromRaw', '-PreviewImage']) {
    const f = path.join(dir, `preview${tag.toLowerCase()}.jpg`);
    await run('exiftool', ['-b', tag, input], { signal, allowFail: true, stdoutFile: f });
    if ((await stat(f)).size === 0) continue;
    let size;
    try {
      size = await imageSize(f, signal);
    } catch {
      throwIfAborted(signal);
      continue;
    }
    if (Math.max(size.width, size.height) < MIN_PREVIEW_EDGE) return null;
    // Embedded previews are stored in sensor orientation; the rotation lives in the RAW's IFD0.
    if (Number.isInteger(orientation) && orientation >= 2 && orientation <= 8) {
      await run('exiftool', ['-q', '-overwrite_original', '-n', `-Orientation=${orientation}`, f], { signal, allowFail: true });
    }
    return f;
  }
  return null;
}

async function thumbnail(input, out, q, signal) {
  await run('vipsthumbnail', [input, '--size', '4096x4096>', '--export-profile', 'srgb', '-o', `${out}[Q=${q},strip]`], {
    signal,
    memLimit: DECODE_MEM_BYTES,
  });
}

export async function handleImage({ key, outKey }, signal) {
  return withTempDir(async (dir) => {
    const ext = safeExt(key);
    const input = path.join(dir, `in${ext}`);
    await download(key, input, signal);

    const meta = await run('exiftool', ['-json', '-n', input], { signal, allowFail: true });
    let exiftool = {};
    try {
      exiftool = JSON.parse(meta.stdout.toString())[0] ?? {};
    } catch {
      exiftool = {};
    }
    delete exiftool.SourceFile;

    let source = input;
    if (RAW_EXTS.has(ext)) {
      source = await embeddedPreview(dir, input, exiftool.Orientation, signal);
      if (!source) {
        source = path.join(dir, 'out.tiff');
        await run('dcraw_emu', ['-T', '-w', '-o', '1', '-Z', source, input], { signal, memLimit: DECODE_MEM_BYTES });
      }
    }

    const out = path.join(dir, 'out.jpeg');
    await thumbnail(source, out, 85, signal);
    if ((await stat(out)).size >= JPEG_LIMIT) await thumbnail(source, out, 75, signal);
    if ((await stat(out)).size >= JPEG_LIMIT) throw new Error('output JPEG is 20 MB or more at Q=75');

    const output = await imageSize(out, signal);
    await putObject(outKey, await readFile(out), signal);
    return { exiftool, output };
  });
}

/**
 * At most `max` jobs run at once; the rest wait in FIFO order. A waiter whose signal aborts leaves the queue and
 * rejects with the signal's reason.
 */
function limiter(max) {
  let active = 0;
  const waiting = [];
  const release = () => {
    active--;
    const next = waiting.shift();
    if (next) next.start();
  };
  return (fn, signal) =>
    new Promise((resolve, reject) => {
      const start = () => {
        signal.removeEventListener('abort', onAbort);
        active++;
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(release);
      };
      const entry = { start };
      const onAbort = () => {
        const i = waiting.indexOf(entry);
        if (i >= 0) waiting.splice(i, 1);
        reject(signal.reason);
      };
      if (signal.aborted) return reject(signal.reason);
      if (active < max) return start();
      waiting.push(entry);
      signal.addEventListener('abort', onAbort, { once: true });
    });
}
const limit = limiter(MAX_JOBS);

async function readJson(req) {
  let body = '';
  for await (const c of req) {
    body += c;
    if (body.length > 64 * 1024) throw new HttpError(413, 'body too large');
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

function send(res, status, body) {
  if (res.headersSent || res.destroyed) return;
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json' });
  res.end(text);
}

const routes = {
  '/video': { fields: ['key', 'posterKey'], handler: handleVideo },
  '/image': { fields: ['key', 'outKey'], handler: handleImage },
};

const server = createServer(async (req, res) => {
  const arrived = Date.now();
  const { pathname } = new URL(req.url, 'http://localhost');
  const ac = new AbortController();
  let started = false;
  // Deadline: 503 while still queued (nothing ran, safe to retry elsewhere), 504 once the job had started.
  const deadline = setTimeout(
    () => ac.abort(started ? new HttpError(504, 'job deadline exceeded') : new HttpError(503, 'queue wait exceeded deadline')),
    JOB_DEADLINE_MS,
  );
  // Client gone before we answered: stop the job and free its slot.
  res.on('close', () => {
    if (!res.writableFinished) ac.abort(new HttpError(499, 'client closed request'));
  });
  try {
    if (req.method === 'GET' && pathname === '/health') return send(res, 200, 'ok');
    const route = routes[pathname];
    if (!route) return send(res, 404, { error: 'not found' });
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
    const body = await readJson(req);
    for (const f of route.fields) {
      if (!validKey(body?.[f])) throw new HttpError(400, `invalid ${f}`);
    }
    const result = await limit(() => {
      // A job that would start with too little of its deadline left is refused instead of being cut off midway.
      if (Date.now() + MIN_JOB_MS > arrived + JOB_DEADLINE_MS) throw new HttpError(503, 'queue wait exceeded deadline');
      started = true;
      return route.handler(body, ac.signal);
    }, ac.signal);
    console.log(`${pathname} ${body.key} 200 ${Date.now() - arrived}ms`);
    send(res, 200, result);
  } catch (err) {
    const [status, message] = classify(err);
    console.error(`${pathname} ${status} ${Date.now() - arrived}ms ${err?.stack ?? err}`);
    send(res, status, { error: message });
  } finally {
    clearTimeout(deadline);
  }
});

server.listen(PORT, () => console.log(`listening on ${server.address().port}`));
