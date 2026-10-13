export class MultipartError extends Error {}

export interface FilePart {
  name: string;
  filename: string;
  contentType: string;
  stream: ReadableStream<Uint8Array>;
}

export interface MultipartHandlers {
  field(name: string, value: string): void;
  file(part: FilePart): Promise<void>;
}

const enc = new TextEncoder();
const CRLF = enc.encode('\r\n');
const HEADER_END = enc.encode('\r\n\r\n');
const MAX_HEADER = 16 * 1024;
const MAX_FIELD = 1024 * 1024;

export function boundaryOf(contentType: string | null): string {
  const m = contentType?.match(/^multipart\/form-data;.*boundary=(?:"([^"]+)"|([^;\s]+))/i);
  const b = m?.[1] ?? m?.[2];
  if (!b) throw new MultipartError('expected multipart/form-data with a boundary');
  return b;
}

function find(haystack: Uint8Array, needle: Uint8Array): number {
  const first = needle[0];
  let i = haystack.indexOf(first);
  while (i !== -1 && i <= haystack.length - needle.length) {
    let j = 1;
    while (j < needle.length && haystack[i + j] === needle[j]) j++;
    if (j === needle.length) return i;
    i = haystack.indexOf(first, i + 1);
  }
  return -1;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

class Reader {
  private buf: Uint8Array = new Uint8Array(0);
  private ended = false;
  constructor(private readonly source: ReadableStreamDefaultReader<Uint8Array>) {}

  private async pull(): Promise<boolean> {
    if (this.ended) return false;
    const { value, done } = await this.source.read();
    if (done) {
      this.ended = true;
      return false;
    }
    this.buf = concat(this.buf, value);
    return true;
  }

  /** Yields bytes up to `delim`, then consumes `delim`. Throws if the body ends first. */
  async *until(delim: Uint8Array, limit = Infinity): AsyncGenerator<Uint8Array> {
    let emitted = 0;
    for (;;) {
      const i = find(this.buf, delim);
      if (i >= 0) {
        emitted += i;
        if (emitted > limit) throw new MultipartError('part too large');
        if (i > 0) yield this.buf.subarray(0, i);
        this.buf = this.buf.subarray(i + delim.length);
        return;
      }
      const keep = delim.length - 1;
      if (this.buf.length > keep) {
        const out = this.buf.subarray(0, this.buf.length - keep);
        emitted += out.length;
        if (emitted > limit) throw new MultipartError('part too large');
        // Copy the tail first: the consumer may hold `out`, and pull() builds a new buffer anyway.
        const tail = this.buf.slice(this.buf.length - keep);
        yield out;
        this.buf = tail;
      }
      if (!(await this.pull())) throw new MultipartError('unexpected end of multipart body');
    }
  }

  async take(n: number): Promise<Uint8Array> {
    while (this.buf.length < n) if (!(await this.pull())) throw new MultipartError('unexpected end of multipart body');
    const out = this.buf.slice(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  cancel(reason?: unknown): Promise<void> {
    return this.source.cancel(reason).catch(() => {});
  }
}

async function readText(gen: AsyncGenerator<Uint8Array>): Promise<string> {
  const dec = new TextDecoder();
  let s = '';
  for await (const chunk of gen) s += dec.decode(chunk, { stream: true });
  return s + dec.decode();
}

function parseHeaders(raw: string): { name: string; filename?: string; contentType: string } {
  let name: string | undefined;
  let filename: string | undefined;
  let contentType = 'application/octet-stream';
  for (const line of raw.split('\r\n')) {
    const sep = line.indexOf(':');
    if (sep < 0) continue;
    const key = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();
    if (key === 'content-type') contentType = value;
    if (key === 'content-disposition') {
      name = value.match(/(?:^|;)\s*name="([^"]*)"/i)?.[1];
      const star = value.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
      try {
        filename = star ? decodeURIComponent(star) : value.match(/(?:^|;)\s*filename="([^"]*)"/i)?.[1];
      } catch {
        throw new MultipartError('malformed filename*');
      }
    }
  }
  if (name === undefined) throw new MultipartError('part without a name');
  return { name, filename, contentType };
}

/** Prepends CRLF so the first boundary matches the same "\r\n--boundary" delimiter as later ones. */
function withLeadingCrlf(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let started = false;
  return new ReadableStream({
    async pull(c) {
      if (!started) {
        started = true;
        c.enqueue(CRLF);
        return;
      }
      const { value, done } = await reader.read();
      if (done) c.close();
      else c.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

export async function parseMultipart(body: ReadableStream<Uint8Array>, boundary: string, handlers: MultipartHandlers): Promise<void> {
  const reader = new Reader(withLeadingCrlf(body).getReader());
  const delim = enc.encode(`\r\n--${boundary}`);
  try {
    for await (const _ of reader.until(delim)) {
      // preamble is discarded
    }
    for (;;) {
      const next = await reader.take(2);
      if (next[0] === 0x2d && next[1] === 0x2d) return; // "--" closes the body
      if (next[0] !== 0x0d || next[1] !== 0x0a) throw new MultipartError('malformed boundary line');
      const headers = parseHeaders(await readText(reader.until(HEADER_END, MAX_HEADER)));
      if (headers.filename === undefined) {
        handlers.field(headers.name, await readText(reader.until(delim, MAX_FIELD)));
        continue;
      }
      const content = reader.until(delim);
      let streamError: unknown;
      const stream = new ReadableStream<Uint8Array>({
        async pull(c) {
          try {
            const r = await content.next();
            if (r.done) c.close();
            else c.enqueue(r.value.slice());
          } catch (e) {
            streamError = e;
            c.error(e);
          }
        },
      });
      await handlers.file({ name: headers.name, filename: headers.filename, contentType: headers.contentType, stream });
      if (streamError) throw streamError;
      for await (const _ of content) {
        // drain whatever the handler did not read
      }
    }
  } catch (err) {
    await reader.cancel(err);
    throw err;
  }
}
