const DEFAULT_PART = 10 * 1024 * 1024;
const MIN_PART = 5 * 1024 * 1024; // R2 multipart minimum for every part except the last

export function toBase64(u: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * Streams `stream` into R2 at `key`, hashing with SHA-1 on the way.
 * Files that fit in one part use put(); larger files use a multipart upload with equal-size parts.
 * On any error the multipart upload is aborted and the error rethrown.
 */
export async function writeToR2(
  bucket: R2Bucket,
  key: string,
  stream: ReadableStream<Uint8Array>,
  opts: { contentType: string; partSize?: number; sizeHint?: number },
): Promise<{ size: number; sha1: Uint8Array }> {
  const partSize = opts.partSize ?? DEFAULT_PART;
  if (partSize < MIN_PART) throw new Error(`partSize must be at least ${MIN_PART} bytes`);
  const digest = new crypto.DigestStream('SHA-1');
  const hasher = digest.getWriter();
  const reader = stream.getReader();
  let upload: R2MultipartUpload | undefined;
  const parts: R2UploadedPart[] = [];
  // Start at the expected size (Content-Length bounds the file) so small uploads do not allocate a full part.
  let part = new Uint8Array(Math.max(1, Math.min(partSize, opts.sizeHint && opts.sizeHint > 0 ? opts.sizeHint : partSize)));
  let filled = 0;
  let size = 0;

  const flush = async () => {
    upload ??= await bucket.createMultipartUpload(key, { httpMetadata: { contentType: opts.contentType } });
    parts.push(await upload.uploadPart(parts.length + 1, part.subarray(0, filled)));
    filled = 0; // uploadPart has finished reading the buffer once awaited, so it is reused
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      await hasher.write(value);
      size += value.length;
      let offset = 0;
      while (offset < value.length) {
        if (filled === part.length && part.length < partSize) {
          const grown = new Uint8Array(Math.min(partSize, Math.max(part.length * 2, filled + value.length - offset)));
          grown.set(part.subarray(0, filled));
          part = grown;
        }
        const n = Math.min(part.length - filled, value.length - offset);
        part.set(value.subarray(offset, offset + n), filled);
        filled += n;
        offset += n;
        if (filled === partSize) await flush();
      }
    }
    await hasher.close();
    if (!upload) {
      await bucket.put(key, part.subarray(0, filled), { httpMetadata: { contentType: opts.contentType } });
    } else {
      if (filled > 0) await flush();
      await upload.complete(parts);
    }
    return { size, sha1: new Uint8Array(await digest.digest) };
  } catch (err) {
    digest.digest.catch(() => {});
    await hasher.abort(err).catch(() => {});
    await reader.cancel(err).catch(() => {});
    await upload?.abort().catch(() => {});
    throw err;
  }
}
