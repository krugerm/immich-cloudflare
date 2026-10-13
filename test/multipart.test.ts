import { describe, expect, it } from 'vitest';
import { MultipartError, parseMultipart } from '../src/upload/multipart';

const enc = new TextEncoder();

function body(parts: Array<{ name: string; value?: string; filename?: string; data?: Uint8Array }>, boundary: string) {
  const chunks: Uint8Array[] = [enc.encode('preamble ignored\r\n')];
  for (const p of parts) {
    const disp = p.filename ? `form-data; name="${p.name}"; filename="${p.filename}"` : `form-data; name="${p.name}"`;
    chunks.push(enc.encode(`--${boundary}\r\nContent-Disposition: ${disp}\r\n`));
    if (p.filename) chunks.push(enc.encode('Content-Type: application/octet-stream\r\n'));
    chunks.push(enc.encode('\r\n'), p.data ?? enc.encode(p.value ?? ''), enc.encode('\r\n'));
  }
  chunks.push(enc.encode(`--${boundary}--\r\n`));
  const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  return all;
}

/** Splits bytes into a stream of `size`-byte chunks so boundaries straddle chunk edges. */
function streamOf(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
  let o = 0;
  return new ReadableStream({
    pull(c) {
      if (o >= bytes.length) return c.close();
      c.enqueue(bytes.slice(o, o + size));
      o += size;
    },
  });
}

async function collect(s: ReadableStream<Uint8Array>) {
  return new Uint8Array(await new Response(s).arrayBuffer());
}

describe('parseMultipart', () => {
  const file = new Uint8Array(70_000).map((_, i) => (i * 31) % 256);
  // file content that contains a near-boundary to make sure partial matches are handled
  file.set(enc.encode('\r\n--XBOUNDAR'), 30_000);

  for (const chunk of [1, 7, 4096, 1 << 20]) {
    it(`parses fields before and after the file with ${chunk}-byte chunks`, async () => {
      const bytes = body(
        [
          { name: 'deviceAssetId', value: 'abc' },
          { name: 'assetData', filename: 'IMG_1.HEIC', data: file },
          { name: 'visibility', value: 'hidden' },
        ],
        'XBOUNDARY',
      );
      const fields: Record<string, string> = {};
      let got: Uint8Array | undefined;
      let filename = '';
      await parseMultipart(streamOf(bytes, chunk), 'XBOUNDARY', {
        field: (n, v) => { fields[n] = v; },
        file: async (p) => { filename = p.filename; got = await collect(p.stream); },
      });
      expect(fields).toEqual({ deviceAssetId: 'abc', visibility: 'hidden' });
      expect(filename).toBe('IMG_1.HEIC');
      expect(got).toEqual(file);
    });
  }

  it('throws on a truncated body', async () => {
    const bytes = body([{ name: 'assetData', filename: 'a.jpg', data: file }], 'XBOUNDARY').slice(0, 50_000);
    await expect(
      parseMultipart(streamOf(bytes, 4096), 'XBOUNDARY', { field: () => {}, file: async (p) => { await collect(p.stream); } }),
    ).rejects.toBeInstanceOf(MultipartError);
  });
});
