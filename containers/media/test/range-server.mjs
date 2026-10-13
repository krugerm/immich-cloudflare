// Test double for the Worker's outbound handler (http://media.r2/<key>): serves files from a directory with HTTP Range
// support, accepts PUTs into an in-memory map, and records what it sent per path.
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

/** Parses a single-range `Range` header against `size`. Returns null when absent, 'invalid' when unsatisfiable. */
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid';
  let start;
  let end;
  if (m[1] === '') {
    // Suffix range: the last N bytes.
    const n = Number(m[2]);
    if (n === 0) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}

/**
 * Starts the server on a random port.
 * @param {string} root directory to serve
 * @param {{failWith?: number, maxChunk?: number}} [opts] failWith: answer every GET/HEAD with this status (for 5xx
 *   tests). maxChunk: answer a Range request with at most this many bytes (a shorter 206 with an accurate
 *   Content-Range, which HTTP allows); ffmpeg then reconnects at the next offset. Without it, an open-ended range that
 *   ffmpeg abandons on a seek is pushed into loopback socket buffers (megabytes), and the byte count measures the
 *   kernel instead of the client.
 */
export async function startRangeServer(root, opts = {}) {
  /** bytes written per path */
  const sent = new Map();
  /** Range start offsets requested per path (0 for a full GET) */
  const starts = new Map();
  /** PUT bodies per path */
  const out = new Map();
  /** content-type of each PUT */
  const outTypes = new Map();

  const server = createServer(async (req, res) => {
    const key = decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(1));
    try {
      if (req.method === 'PUT') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        out.set(key, Buffer.concat(chunks));
        outTypes.set(key, req.headers['content-type']);
        res.writeHead(201).end();
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405).end();
        return;
      }
      if (opts.failWith) {
        res.writeHead(opts.failWith).end();
        return;
      }
      // stall/<path>: send the headers and the first 4 KB of <path>, then never finish (a stuck origin).
      const stall = key.startsWith('stall/');
      const file = path.join(root, stall ? key.slice('stall/'.length) : key);
      if (!file.startsWith(path.resolve(root) + path.sep)) {
        res.writeHead(400).end();
        return;
      }
      let size;
      try {
        size = (await stat(file)).size;
      } catch {
        res.writeHead(404).end();
        return;
      }
      const range = parseRange(req.headers.range, size);
      if (range === 'invalid') {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
        return;
      }
      const start = range ? range.start : 0;
      let end = range ? range.end : size - 1;
      if (range && opts.maxChunk) end = Math.min(end, start + opts.maxChunk - 1);
      const headers = { 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': 'application/octet-stream' };
      if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      res.writeHead(range ? 206 : 200, headers);
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      if (!starts.has(key)) starts.set(key, []);
      starts.get(key).push(start);
      if (stall) {
        createReadStream(file, { start, end: Math.min(end, start + 4095) }).on('data', (c) => res.write(c));
        return;
      }
      const stream = createReadStream(file, { start, end, highWaterMark: 16 * 1024 });
      stream.on('data', (c) => {
        sent.set(key, (sent.get(key) ?? 0) + c.length);
        if (!res.write(c)) {
          stream.pause();
          res.once('drain', () => stream.resume());
        }
      });
      stream.on('end', () => res.end());
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
    } catch {
      res.destroy();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    sent,
    starts,
    out,
    outTypes,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}
