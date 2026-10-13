# Phase 3: Media Container Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Videos, RAW files and images over 20 MB get thumbnails, a thumbhash, dimensions, duration and capture metadata through a Cloudflare Container running ffmpeg, exiftool, libraw and libvips.

**Architecture:** The `asset-process` Queue consumer calls a `MediaContainer` (Durable Object `Container` class) over HTTP. The container reads originals through an outbound handler `http://media.r2/<key>` backed by the `MEDIA` R2 binding (Range supported, no credentials), writes one derived JPEG back through the same handler, and returns raw `ffprobe`/`exiftool` JSON. The Worker parses that JSON, renders `preview.jpeg` and `thumbnail.webp` from the derived JPEG with the Images binding, and commits through `changes` as phase 1 does for photos.

**Tech Stack:** Cloudflare Workers, `@cloudflare/containers`, D1, R2, Queues, Images binding; container image Debian trixie-slim with ffmpeg, libimage-exiftool-perl, libraw-bin, libvips-tools, nodejs.

**Spec:** `docs/superpowers/specs/2026-10-12-immich-cloudflare-design.md` (sections 3.1, 7.2, 9). Platform facts: `docs/research/2026-10-13-phase3-platform.md`.

## Global Constraints

- Contract file `src/container/contract.ts` (committed in Task 0) is fixed. Streams build against it; changes go through the controller.
- Derived R2 keys are only `derived/<assetId>/poster.jpeg` and `derived/<assetId>/full.jpeg` (`derivedKey`). Purge already deletes them.
- Images binding input: at most 20 MB and 100 MP. Container output JPEG: long edge at most 3840 px (poster) or 4096 px (image), under 20 MB.
- Queue consumer wall time is 15 minutes; each container call must finish in under 2 minutes for a 2 GB file (Range reads, no full copy for video).
- Container: `standard-1`, `max_instances` 3, `sleepAfter` "5m", internet egress off, amd64 image.
- Synced rows (`assets`, `asset_exif`) are written only through `tracked()`/`commit()`, one row per statement.
- `duration` is integer milliseconds (Immich 3.x `getDuration`). Video `width`/`height` are display size after rotation.
- Errors: HTTP 422 from the container means undecodable input (`MediaInputError`, asset `failed`); anything else is retried by the queue.
- No new D1 migrations are needed. If one becomes necessary, use range `0100`–`0109` and ask the controller.
- Builds and tests run Docker on a Linux x86_64 build host; the laptop's Docker runs out of memory. Batch remote commands into one SSH session.
- Commits: plain messages, no AI attribution, no Co-Authored-By. `npx vitest run --testTimeout=60000` and `npx tsc --noEmit` green before every commit.

## Review Focus

1. iPhone `.MOV` with `moov` at the end of a 1–2 GB file: probe and poster must use Range reads and finish in seconds. Test: the container smoke test serves a moov-at-end fixture through a Range server that logs bytes sent, and asserts bytes sent < 10% of file size (Task A).
2. 10-bit HDR HEVC (iPhone default): the poster must be tone-mapped to SDR so it keeps normal contrast. Test: the HDR fixture's poster mean luma is within the range of an SDR reference frame (Task A).
3. Rotated video (portrait iPhone video is stored landscape with a rotation matrix): `width`/`height` and the poster must be upright. Test: ffprobe JSON with `side_data_list` rotation -90 gives width < height (Task C), and the poster of the rotated fixture is taller than wide (Task A).
4. A video or RAW with no metadata (screen recording, stripped file): processing still reaches `ready`, dates fall back to `file_created_at`. Test in Task C and Task D.
5. Container unavailable or failing (cold start error, 5xx, timeout): the message is retried, the asset is never marked `failed`, and after retries it goes to the dead-letter path as today. Test: a processor that throws a plain `Error` makes `processAsset` reject (Task C, Task D); the client maps 422 to `MediaInputError` and 500/timeout to plain errors (Task B).

## Execution shape

Task 0 is done (commit `3674563` on branch `phase3`). Tasks A to E run in parallel, one worktree each, branched from `phase3`. Task F runs after all five merge.

| Task | Owns (only these files) |
|---|---|
| A | `containers/media/**`, `scripts/media-fixtures.sh`, `test/fixtures/media/**` |
| B | `src/container/client.ts`, `src/container/hub.ts` (new), `src/container/outbound.ts` (new), `wrangler.jsonc`, `vitest.config.ts`, `src/index.ts` (export line only), `test/container-*.test.ts`, `package.json` (one dependency) |
| C | `src/process/video.ts`, `src/process/ffprobe.ts` (new), `test/process-video.test.ts` |
| D | `src/process/large-image.ts`, `src/process/exiftool-map.ts` (new), `test/process-large-image.test.ts` |
| E | `src/jobs/routes.ts`, `src/cron/index.ts`, `test/jobs-needs-media.test.ts`, `README.md` |

Shared test helper (all streams may use, none may change): `test/helpers.ts` (`createUser`, `login`, `uploadAsset`, `authHeaders`, `BASE`). Fake processor pattern for C and D:

```ts
import type { MediaProcessor, VideoResult, ImageResult } from '../src/container/contract';
function fakeProcessor(over: Partial<{ video: VideoResult | Error; image: ImageResult | Error }>): MediaProcessor & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async video(key, posterKey) {
      calls.push(['video', key, posterKey]);
      const v = over.video;
      if (v instanceof Error) throw v;
      await env.MEDIA.put(posterKey, new Uint8Array([0xff, 0xd8, 0xff]));
      return v!;
    },
    async image(key, outKey) {
      calls.push(['image', key, outKey]);
      const i = over.image;
      if (i instanceof Error) throw i;
      await env.MEDIA.put(outKey, new Uint8Array([0xff, 0xd8, 0xff]));
      return i!;
    },
  };
}
```

The fake thumbnailer is the one in `test/process.test.ts` (`fakeThumbnailer`); copy it into the new test file.

---

### Task 0: Contract and hooks (done, `3674563`)

`src/container/contract.ts` (types, `derivedKey`, `MediaInputError`), `src/container/client.ts` stub returning `undefined`, `src/process/video.ts` and `src/process/large-image.ts` stubs calling `markNeedsMedia`, `processAsset(env, id, thumbnailer, force, processor?)` dispatch, helpers exported from `src/process/consumer.ts`: `exifStatement(a, exif)`, `enqueueBackup(env, id)`, `markNeedsMedia(env, a, now)`, `markFailed(env, a, error, now, exif?)`, `renderThumbnails(env, assetId, bytes, thumbnailer, orientation) → {thumbhash, width, height}`, `isImagesInputError(err)`. `assetObjectKeys` includes both derived keys.

---

### Task A: Container image and server

**Files:**
- Create: `containers/media/Dockerfile`, `containers/media/server.mjs`, `containers/media/package.json`, `containers/media/test/server.test.mjs`, `containers/media/test/range-server.mjs`
- Create: `scripts/media-fixtures.sh`, `test/fixtures/media/` (generated fixtures, each under 3 MB, plus `SOURCES.md`)

**Interfaces:**
- Produces: HTTP server on port 8080.
  - `POST /video` body `{"key": string, "posterKey": string}` → 200 `VideoResult` JSON. Runs `ffprobe -v error -print_format json -show_format -show_streams -multiple_requests 1 -initial_request_size 65536 <base>/<key>`, then `ffmpeg -multiple_requests 1 -ss <t> -i <base>/<key> -frames:v 1 -vf <filter> -q:v 3 -f mjpeg pipe:1` where `t` = min(1, duration/2) and `<filter>` tone-maps when the stream's `color_transfer` is `smpte2084` or `arib-std-b67` (`zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p`) and always ends with `scale='min(3840,iw)':'min(3840,ih)':force_original_aspect_ratio=decrease`. ffmpeg auto-rotates. PUTs the JPEG to `<base>/<posterKey>` with `Content-Type: image/jpeg` and returns its size from `ffprobe` of the JPEG bytes (or from vips header).
  - `POST /image` body `{"key", "outKey"}` → 200 `ImageResult`. Downloads the original to `/tmp/<random>/in<ext>` (streamed to disk), runs `exiftool -json -n` on it, then: for RAW extensions (`.dng .cr2 .cr3 .nef .arw .raf .orf .rw2 .pef .srw .x3f .3fr .iiq .erf .kdc .dcr .mrw .nrw .rwl .sr2 .srf`) extracts the largest embedded preview (`exiftool -b -JpgFromRaw`, else `-PreviewImage`) when its long edge is at least 1440 px, else decodes with `dcraw_emu -T -w -o 1 -Z /tmp/.../out.tiff`; then `vipsthumbnail <input> --size 4096x4096 --export-profile srgb -o out.jpeg[Q=85,strip]` (vipsthumbnail auto-rotates). For non-RAW inputs it runs vipsthumbnail directly. If the JPEG is 20 MB or more, re-encode at Q=75. PUTs it to `<base>/<outKey>`, deletes the temp directory, returns `{exiftool, output: {width, height}}` from `vipsheader`.
  - Errors: tool exit with "Invalid data", "moov atom not found", "unsupported", or vips load failure → 422 `{"error": "<first stderr line>"}`. Base URL fetch errors or 5xx → 502. Anything else → 500. `GET /health` → 200 `ok`.
  - Base URL: `process.env.MEDIA_BASE_URL ?? 'http://media.r2'`.
  - Concurrency: at most 2 jobs at once; extra requests wait (simple promise queue).
- Dockerfile: `FROM debian:trixie-slim`, `apt-get install --no-install-recommends ffmpeg libimage-exiftool-perl libraw-bin libvips-tools nodejs ca-certificates`, copy `server.mjs`, `EXPOSE 8080`, `CMD ["node", "server.mjs"]`. Verify `ffmpeg -filters | grep zscale` succeeds in the build (`RUN` step), failing the build otherwise.

- [ ] **Step 1: Fixtures.** Write `scripts/media-fixtures.sh` that runs inside the built image on the build host and writes to `test/fixtures/media/`: `hdr-hevc-moov-end.mov` (3 s, 1280x720, `libx265 -pix_fmt yuv420p10le -x265-params colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc`, metadata `-metadata:g com.apple.quicktime.creationdate=2024-07-14T18:03:12+0300 -metadata:g com.apple.quicktime.location.ISO6709=+34.6823+033.0464+012.000/ -movflags use_metadata_tags`, no faststart so moov is at the end); `rotated.mov` (2 s, 1280x720 H.264, `-display_rotation 90` on the input or `-metadata:s:v rotate=90`); `plain.mp4` (2 s, no metadata); `big.jpg` (`vips black` 8000x6000 + noise so it is over 20 MB at Q=100); and one DNG downloaded from raw.pixls.us under CC0 (record URL and licence in `SOURCES.md`; pick one under 3 MB). Large fixtures (`big.jpg`) are generated at test time and stay out of git.
- [ ] **Step 2: Range server.** `test/range-server.mjs` serves a directory with `206`/`Content-Range`/`Accept-Ranges: bytes`, open-ended ranges, `HEAD`, accepts `PUT` into an `out/` map, and counts bytes sent per path.
- [ ] **Step 3: Failing tests** in `test/server.test.mjs` (node:test, run with `node --test` inside the image): `/video` on `hdr-hevc-moov-end.mov` returns streams with `codec_type` video and format tags containing the creationdate and ISO6709 keys, writes a poster whose mean luma (`ffmpeg -f lavfi signalstats` or vips `avg`) is between 40 and 200, and bytes sent < 50% of file size (fixture is small; also assert ffprobe used Range by checking the server saw at least one non-zero start offset); `/video` on `rotated.mov` writes a poster with height > width; `/image` on the DNG returns exiftool `Make` and writes a JPEG under 20 MB with long edge <= 4096; `/image` on a generated `big.jpg` writes a JPEG under 20 MB; `/video` on a text file renamed `.mov` returns 422.
- [ ] **Step 4: Implement** `server.mjs` with `node:http`, `child_process.spawn` (never `exec` with a shell; pass arguments as arrays; reject keys containing `..` or starting with `/`).
- [ ] **Step 5: Build and test on the build host** in one SSH session: `rsync -a --delete containers/media/ test/fixtures/media/ <build-host>:~/immich-cf-media/` (keep layout), then `ssh <build-host> 'cd ~/immich-cf-media && docker build --platform linux/amd64 -t immich-cf-media . && docker run --rm -v $PWD/fixtures:/fixtures immich-cf-media node --test test/'`. Expected: all pass. Paste the output into the report.
- [ ] **Step 6: Commit** `containers/media`, the script and the small fixtures: "Add media container: ffprobe/ffmpeg posters and RAW/large image decode".

---

### Task B: Worker side of the container

**Files:**
- Create: `src/container/hub.ts` (class `MediaContainer extends Container`), `src/container/outbound.ts`, `test/container-outbound.test.ts`, `test/container-client.test.ts`
- Modify: `src/container/client.ts`, `wrangler.jsonc`, `vitest.config.ts`, `src/index.ts` (add `export { MediaContainer } from './container/hub';` next to the RealtimeHub export), `package.json` (`@cloudflare/containers`)

**Interfaces:**
- Consumes: `MediaProcessor`, `MediaInputError`, `VideoResult`, `ImageResult` from `src/container/contract.ts`.
- Produces: `containerProcessor(env): MediaProcessor | undefined` (undefined when `env.MEDIA_CONTAINER` is absent); `handleMediaOutbound(request: Request, env: Env): Promise<Response>` in `outbound.ts`.

Rules for the outbound handler (`media.r2` host):
- `GET`/`HEAD` allowed only for keys under `originals/` and `derived/`; others 403. Missing object 404.
- `Range: bytes=a-b`, `bytes=a-`, `bytes=-n` → 206 with `Content-Range: bytes a-b/size`, `Content-Length`, `Accept-Ranges: bytes`. No Range → 200 with `Content-Length`. Use `env.MEDIA.get(key, { range: request.headers })` and the returned `range`/`size`. Unsatisfiable range → 416.
- `PUT` allowed only for keys matching `^derived/[0-9a-f-]{36}/(poster|full)\.jpeg$`, body streamed to `env.MEDIA.put` with `httpMetadata.contentType = 'image/jpeg'`; Content-Length required (411 otherwise) and at most 20 MB (413).
- Key is the URL path without the leading `/`, percent-decoded once; reject `..`.

Container class: `defaultPort = 8080`, `sleepAfter = '5m'`, `enableInternet = false`, `static outboundByHost = { 'media.r2': (req, env) => handleMediaOutbound(req, env) }` (follow the current `@cloudflare/containers` API in node_modules; the research report quotes the shape). wrangler: add to `containers` `{ "class_name": "MediaContainer", "image": "./containers/media/Dockerfile", "instance_type": "standard-1", "max_instances": 3 }`, add the DO binding `MEDIA_CONTAINER`, and append a migration `{ "tag": "v2-media-container", "new_sqlite_classes": ["MediaContainer"] }` (the project uses `migrations`, so do not add `exports`). Run `npm run gen` so `Env` gains `MEDIA_CONTAINER`.

Client: `video(key, posterKey)` → `getRandom(env.MEDIA_CONTAINER, 3)` (or the current equivalent) `.fetch('http://container/video', {method:'POST', body: JSON.stringify({key, posterKey}), headers: {'content-type':'application/json'}, signal: AbortSignal.timeout(120_000)})`; 200 → parsed JSON; 422 → `throw new MediaInputError(body.error)`; other status or abort → `throw new Error('media container <status>: <text>')`. Same for `image`.

Tests must not need Docker. If `vitest.config.ts` with the `containers` block makes Miniflare try to build the image, override in the test config (for example pass a test-only wrangler config without `containers`, or the plugin's option to skip containers) and document the choice in the report. Unit-test the client by passing a fake namespace object with `get()`/`idFromName()`-compatible stubs whose `fetch` returns canned responses; export a `processorFor(stubFetch)` helper from `client.ts` if needed so tests avoid the real binding.

- [ ] **Step 1: Failing outbound tests** (real `env.MEDIA`): put a 1000-byte object at `originals/u/a.mov`; `GET` with `bytes=10-19` → 206, body bytes 10..19, `Content-Range: bytes 10-19/1000`; `bytes=990-` → 10 bytes; `bytes=-5` → last 5; no Range → 200 and 1000 bytes; `HEAD` → `Content-Length: 1000`; `GET thumbs/x` → 403; `PUT derived/<uuid>/poster.jpeg` with 3 bytes → 201 and the object exists with content type `image/jpeg`; `PUT originals/u/b.mov` → 403; `GET derived/../originals/u/a.mov` → 403; missing key → 404.
- [ ] **Step 2: Failing client tests:** 200 → result; 422 `{error:'moov atom not found'}` → rejects with `MediaInputError`; 500 → rejects with plain `Error` (not `MediaInputError`); `containerProcessor({...env, MEDIA_CONTAINER: undefined})` → `undefined`.
- [ ] **Step 3: Implement** `outbound.ts`, `hub.ts`, `client.ts`, wrangler and vitest config, `npm run gen`.
- [ ] **Step 4: Run** `npx vitest run --testTimeout=60000` and `npx tsc --noEmit`; both green, existing 519 tests still pass.
- [ ] **Step 5: Verify the deploy config** with `npx wrangler deploy --dry-run --outdir /tmp/immich-cf-dry` and paste the binding table (no real deploy). If the dry run needs Docker to build the image, note it and skip; Task F handles the image.
- [ ] **Step 6: Commit** "Add MediaContainer binding, R2 outbound handler and container client".

---

### Task C: Video processing

**Files:**
- Create: `src/process/ffprobe.ts`, `test/process-video.test.ts`
- Modify: `src/process/video.ts`

**Interfaces:**
- Consumes: `MediaProcessor`, `VideoResult`, `FfprobeOutput`, `MediaInputError`, `derivedKey` (contract); `exifStatement`, `markFailed`, `renderThumbnails`, `enqueueBackup`, `isImagesInputError` (consumer.ts); `localDateTime` (exif.ts); `emitUploadReady` (realtime/emit.ts); `ExtractedExif` (exif.ts).
- Produces: `parseFfprobe(out: FfprobeOutput): { exif: ExtractedExif; durationMs: number | null; width: number | null; height: number | null }`; `processVideo(env, a, thumbnailer, processor, now)` (signature fixed by Task 0).

Parsing rules (`parseFfprobe`):
- Video stream = first stream with `codec_type === 'video'`. Rotation = `side_data_list[].rotation` of type `Display Matrix`, else stream tag `rotate`; if `abs(rotation) % 180 === 90`, swap width and height.
- `durationMs` = `Math.round(parseFloat(format.duration ?? stream.duration) * 1000)` when finite, else null.
- Date: format tag `com.apple.quicktime.creationdate` (`2024-07-14T18:03:12+0300`) → `dateTimeOriginal` = that instant in UTC ISO, `timeZone` = `UTC+3` (same formatting `src/process/exif.ts` uses for offsets; read it and reuse its helper). Else `creation_time` (format, then stream) → `dateTimeOriginal`, `timeZone` null. Else null.
- GPS: tag `com.apple.quicktime.location.ISO6709` or `location` (`+34.6823+033.0464+012.000/`) → latitude/longitude rounded to 6 decimals; `+00.0000+000.0000` counts as no GPS.
- `make`/`model` from `com.apple.quicktime.make`/`model` (or `make`/`model`), `description` '' , other EXIF fields null, `exifImageWidth/Height` = display width/height.
- Tag lookups are case-insensitive.

`processVideo` behaviour:
1. `result = await processor.video(a.original_path, derivedKey(a.id, 'poster'))`. `MediaInputError` → `markFailed(env, a, err.message, now)` and return. Other errors propagate (queue retry).
2. `parsed = parseFfprobe(result.ffprobe)`.
3. Read the poster from R2 (`env.MEDIA.get(derivedKey(a.id,'poster'))`; missing → throw Error, retry). `renderThumbnails(env, a.id, posterBytes, thumbnailer, null)`; an Images input error → `markFailed(..., exif)`.
4. One `commit`: `exifStatement(a, parsed.exif)` and a tracked UPDATE setting `status='ready'`, `error=NULL`, `has_thumbnail=1`, `thumbhash`, `width`/`height` (parsed, falling back to the poster size), `duration` (ms), `local_date_time` with the same locked-`dateTimeOriginal` CASE as the photo path, `updated_at`, `update_id`.
5. `emitUploadReady(env, a.id)`, `enqueueBackup(env, a.id)`.

- [ ] **Step 1: Failing parser tests** with literal `FfprobeOutput` objects: iPhone-style (creationdate +0300, ISO6709, make Apple, model iPhone 15 Pro, rotation -90 on 1920x1080 → width 1080, height 1920, duration "12.345678" → 12346); `creation_time` only → `timeZone` null; no tags → all null, description ''; `+00.0000+000.0000/` → no GPS; stream `rotate` tag "90" handled.
- [ ] **Step 2: Failing `processAsset` tests** (upload a `.mov` via `uploadAsset(token, bytes, {filename:'clip.mov'})` or set `type='VIDEO'` and `original_path` by SQL as `test/process.test.ts` does for its cases; read that file first): with the fake processor → status `ready`, `duration` 12346, `thumbhash` set, `asset_exif.latitude` 34.6823, `local_date_time` = 2024-07-14T18:03:12.000Z, `thumbs/<id>/preview.jpeg` exists, processor called with `(original_path, derived/<id>/poster.jpeg)`; `MediaInputError` → status `failed`, error text stored, backup still queued; plain `Error` → `processAsset` rejects and status stays `pending`; no metadata → `ready`, `local_date_time` = `file_created_at`; a `dateTimeOriginal` lock in `asset_exif.locked_properties` survives re-processing with `force`; without a processor (`processAsset(env,id,t)`) → `needs_media` (unchanged behaviour).
- [ ] **Step 3: Implement** `ffprobe.ts` and `video.ts`.
- [ ] **Step 4: Run** full suite and typecheck; green.
- [ ] **Step 5: Commit** "Process videos through the media container: metadata, duration, poster thumbnails".

---

### Task D: RAW and large images

**Files:**
- Create: `src/process/exiftool-map.ts`, `test/process-large-image.test.ts`
- Modify: `src/process/large-image.ts`

**Interfaces:**
- Consumes: as Task C, plus `ImageResult`, `ExiftoolOutput`.
- Produces: `mapExiftool(out: ExiftoolOutput): ExtractedExif`; `processLargeImage(env, a, thumbnailer, processor, now)`.

Mapping rules (`mapExiftool`, values from `exiftool -json -n`): `Make`, `Model`, `LensModel` (else `Lens`), `ExposureTime` (number → string as Immich formats it: values < 1 as `1/<round(1/x)>`, else the number as a string; read `src/process/exif.ts` and reuse its formatter), `FNumber`, `FocalLength`, `ISO`, `GPSLatitude`/`GPSLongitude` (6 decimals; both 0 = none), `DateTimeOriginal` (`2024:07:14 18:03:12`) combined with `OffsetTimeOriginal` (`+03:00`) the same way `src/process/exif.ts` combines exifr's values (reuse its helpers so photos and RAW agree), `Orientation` (as string), `Rating` (1..5 else null), `ImageDescription` (else ''), `ExifImageWidth`/`ExifImageHeight` (else `ImageWidth`/`ImageHeight`), `ProfileDescription`, `ProjectionType`, `width`/`height` = `ImageWidth`/`ImageHeight` before orientation.

`processLargeImage` behaviour:
1. `result = await processor.image(a.original_path, derivedKey(a.id, 'full'))`. `MediaInputError` → `markFailed` and return; other errors propagate.
2. `exif = mapExiftool(result.exiftool)`.
3. Read `derived/<id>/full.jpeg`; `renderThumbnails(env, a.id, bytes, thumbnailer, null)` (the container's JPEG is upright). Images input error → `markFailed(..., exif)`.
4. Commit as the photo path does (`exifStatement`, status `ready`, thumbhash, width/height from EXIF with orientation swap, falling back to the thumbnail size; `local_date_time`), then `emitUploadReady`, `enqueueBackup`.

- [ ] **Step 1: Failing mapping tests:** a Sony ARW-style object (Make SONY, Model ILCE-7M4, ExposureTime 0.004 → "1/250", FNumber 2.8, ISO 400, DateTimeOriginal + OffsetTimeOriginal +03:00, Orientation 6, ImageWidth 7008, ImageHeight 4672); an empty object → all null, description ''; GPS 0/0 → null.
- [ ] **Step 2: Failing `processAsset` tests:** a `.dng` asset (IMAGE type, outside `THUMBNAIL_INPUTS`) and a 25 MB `.jpg` (set `file_size` by SQL) both call `processor.image` with `derived/<id>/full.jpeg`, end `ready` with thumbhash and EXIF, orientation 6 → width 4672 height 7008; `MediaInputError` → `failed`; plain `Error` → rejects; small JPEG still takes the Images path (processor not called).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** full suite and typecheck; green.
- [ ] **Step 5: Commit** "Process RAW and large images through the media container".

---

### Task E: Requeue and job status for `needs_media`

**Files:**
- Modify: `src/jobs/routes.ts`, `src/cron/index.ts`, `README.md`
- Create: `test/jobs-needs-media.test.ts`

**Interfaces:**
- Consumes: `PROCESS_QUEUE` binding; existing `startQueue`, `queueState`, the stale-pending requeue in `src/cron/index.ts`.
- Produces: no new exports.

Behaviour:
- `PUT /api/jobs/<thumbnail or metadata queue>` with `{command:'start'}` (non-force) re-enqueues assets with status `pending`, `failed` and `needs_media` (today: `pending`, `failed`). Read `startQueue` first.
- Job statistics count `needs_media` as `waiting`.
- The daily cron step that re-enqueues stale `pending` assets also re-enqueues `needs_media` assets, at most 200 per run, oldest first, only when `env.MEDIA_CONTAINER` is bound (check with `'MEDIA_CONTAINER' in env`, since Task B adds the binding in parallel; keep the check type-safe with a cast `(env as unknown as Record<string, unknown>).MEDIA_CONTAINER`).
- README: a "Media container" section: what it does, that a Linux x86_64 Docker host builds the image, `standard-1` cost note from the research report, and how to backfill (`PUT /api/jobs/thumbnailGeneration {"command":"start"}` as admin).

- [ ] **Step 1: Failing tests:** start (non-force) enqueues a `needs_media` asset (spy on `PROCESS_QUEUE.sendBatch` as `test/cron.test.ts` does); stats count it as waiting; cron requeues `needs_media` only when a `MEDIA_CONTAINER` stub is present on env (pass `{...env, MEDIA_CONTAINER: {}}`) and not without it; cap at 200.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run** full suite and typecheck; green.
- [ ] **Step 4: Commit** "Requeue needs_media assets when the media container is available".

---

### Task F: Integrate, deploy, backfill (controller, after A to E merge)

- [ ] Merge A to E into `phase3`; full suite and typecheck green.
- [ ] Whole-branch review (one reviewer, most capable model).
- [ ] Deploy: the image builds from `containers/media/Dockerfile`. Build on the build host and push with `wrangler containers push` if the Mac's Docker cannot build amd64 in reasonable time; otherwise `npx wrangler deploy` from the Mac. Record which path worked.
- [ ] Smoke on staging: process one known video (`POST /api/assets/jobs` or the job start) and check `GET /api/assets/<id>` shows `duration`, `thumbhash`, `width`, `height`, and `GET /api/assets/<id>/thumbnail` returns 200.
- [ ] Backfill: start the thumbnail job as admin (read-only check of counts before and after with `wrangler d1 execute --remote --command "select status, count(*) ..."`). Exit check: zero `needs_media` videos on staging; every video has `duration` and a thumbnail.
- [ ] Merge `phase3` into main and push.
