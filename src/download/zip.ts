/** Streaming ZIP writer: STORE method with data descriptors, so no file is ever held whole. No ZIP64. */

export interface ZipEntry {
  name: string;
  modified: Date;
  /** Opens the file body; null skips the entry (for example a missing object). */
  open(): Promise<ReadableStream<Uint8Array> | null>;
}

/** Mutable so tests can shrink them. maxEntries is archive policy; the ZIP format itself allows 65535 without ZIP64. */
export const zipLimits = { maxBytes: 0xffffffff, maxEntries: 500 };
/** Per-entry bytes outside the file data: local header, descriptor and central record with a name of up to 255 UTF-8 characters. */
export const ENTRY_OVERHEAD = 30 + 16 + 46 + 2 * 3 * 255;
const END_RECORD = 22;

/** True when `count` entries holding `dataBytes` of file data are guaranteed to fit one ZIP without ZIP64. */
export function fitsZip(dataBytes: number, count: number): boolean {
  return count <= zipLimits.maxEntries && dataBytes + count * ENTRY_OVERHEAD + END_RECORD <= zipLimits.maxBytes;
}

const enc = new TextEncoder();

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32Update(crc: number, data: Uint8Array): number {
  let c = crc;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return c >>> 0;
}

export const crc32 = (data: Uint8Array) => (crc32Update(0xffffffff, data) ^ 0xffffffff) >>> 0;

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getUTCFullYear());
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

const FLAGS = 0x0808; // bit 3: sizes and CRC follow the data; bit 11: UTF-8 names

function localHeader(name: Uint8Array, time: number, date: number): Uint8Array {
  const b = new Uint8Array(30 + name.length);
  const v = new DataView(b.buffer);
  v.setUint32(0, 0x04034b50, true);
  v.setUint16(4, 20, true);
  v.setUint16(6, FLAGS, true);
  v.setUint16(8, 0, true);
  v.setUint16(10, time, true);
  v.setUint16(12, date, true);
  v.setUint16(26, name.length, true);
  b.set(name, 30);
  return b;
}

function descriptor(crc: number, size: number): Uint8Array {
  const b = new Uint8Array(16);
  const v = new DataView(b.buffer);
  v.setUint32(0, 0x08074b50, true);
  v.setUint32(4, crc, true);
  v.setUint32(8, size, true);
  v.setUint32(12, size, true);
  return b;
}

function centralHeader(name: Uint8Array, time: number, date: number, crc: number, size: number, offset: number): Uint8Array {
  const b = new Uint8Array(46 + name.length);
  const v = new DataView(b.buffer);
  v.setUint32(0, 0x02014b50, true);
  v.setUint16(4, 20, true);
  v.setUint16(6, 20, true);
  v.setUint16(8, FLAGS, true);
  v.setUint16(10, 0, true);
  v.setUint16(12, time, true);
  v.setUint16(14, date, true);
  v.setUint32(16, crc, true);
  v.setUint32(20, size, true);
  v.setUint32(24, size, true);
  v.setUint16(28, name.length, true);
  v.setUint32(42, offset, true);
  b.set(name, 46);
  return b;
}

function endRecord(count: number, cdSize: number, cdOffset: number): Uint8Array {
  const b = new Uint8Array(22);
  const v = new DataView(b.buffer);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(8, count, true);
  v.setUint16(10, count, true);
  v.setUint32(12, cdSize, true);
  v.setUint32(16, cdOffset, true);
  return b;
}

async function* generate(entries: ZipEntry[]): AsyncGenerator<Uint8Array> {
  if (entries.length > 0xffff) throw new Error('too many entries for a ZIP without ZIP64');
  const central: Uint8Array[] = [];
  let offset = 0;
  /** Every byte written (headers, data, descriptors, central directory) counts toward the 32-bit limit. */
  const grow = (n: number) => {
    offset += n;
    if (offset > zipLimits.maxBytes) throw new Error('archive exceeds the ZIP size limit');
  };
  for (const entry of entries) {
    const body = await entry.open();
    if (!body) continue;
    const name = enc.encode(entry.name);
    const { time, date } = dosDateTime(entry.modified);
    const entryOffset = offset;
    const reader = body.getReader();
    try {
      const header = localHeader(name, time, date);
      grow(header.length);
      yield header;
      let crc = 0xffffffff;
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        crc = crc32Update(crc, value);
        size += value.length;
        grow(value.length);
        yield value;
      }
      crc = (crc ^ 0xffffffff) >>> 0;
      const tail = descriptor(crc, size);
      grow(tail.length);
      yield tail;
      central.push(centralHeader(name, time, date, crc, size, entryOffset));
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  const cdOffset = offset;
  let cdSize = 0;
  for (const c of central) {
    cdSize += c.length;
    grow(c.length);
    yield c;
  }
  grow(END_RECORD);
  yield endRecord(central.length, cdSize, cdOffset);
}

export function zipStream(entries: ZipEntry[]): ReadableStream<Uint8Array> {
  const gen = generate(entries);
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const r = await gen.next();
          if (r.done) controller.close();
          else controller.enqueue(r.value);
        } catch (err) {
          console.error('zip stream failed', err);
          controller.error(err); // a truncated archive must not look complete
        }
      },
      async cancel() {
        await gen.return(undefined);
      },
    },
    { highWaterMark: 1 },
  );
}
