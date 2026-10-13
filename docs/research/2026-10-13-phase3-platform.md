# Phase 3 platform research: media container and large-upload ingest

Researched 2026-10-13 from Cloudflare, Fly.io and FFmpeg docs. Items marked UNVERIFIED have no doc source; test them before relying on them.

## 1. Cloudflare Containers

### Status and pricing
- GA since 2026-04-13 (Containers and Sandboxes). https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/
- Workers Paid plan only ($5/month). No Free tier access.
- Billed per 10 ms while running. https://developers.cloudflare.com/containers/platform/pricing/
  - Memory: 25 GiB-hours/month included, then $0.0000025 per GiB-second (provisioned).
  - CPU: 375 vCPU-minutes/month included, then $0.000020 per vCPU-second (active use only).
  - Disk: 200 GB-hours/month included, then $0.00000007 per GB-second (provisioned).
  - Egress (NA/EU): 1 TB/month included, then $0.025/GB.
  - Worker and Durable Object usage is billed on top.
- Example: `standard-1` busy for 1 minute costs about $0.0006 memory + $0.0006 CPU + $0.00003 disk, so about $0.0012/min once past the included usage. The included memory covers about 6 hours of `standard-1` per month.

### Instance types (https://developers.cloudflare.com/containers/platform/limits/)

| Type | vCPU | Memory | Disk |
| --- | --- | --- | --- |
| lite | 1/16 | 256 MiB | 2 GB |
| basic | 1/4 | 1 GiB | 4 GB |
| standard-1 | 1/2 | 4 GiB | 8 GB |
| standard-2 | 1 | 6 GiB | 12 GB |
| standard-3 | 2 | 8 GiB | 16 GB |
| standard-4 | 4 | 12 GiB | 20 GB |

- Custom types: 1 to 4 vCPU, up to 12 GiB, up to 20 GB disk, at least 3 GiB per vCPU.
- Max image size equals the instance disk size. Account image storage is 50 GB.
- Account concurrency: 6 TiB memory, 1,500 vCPU, 30 TB disk. Per application, `max_instances` caps running instances.
- Disk is ephemeral. A sleeping instance restarts with a fresh disk. https://developers.cloudflare.com/containers/faq/
- No swap. OOM restarts the instance.
- Images must be `linux/amd64`. Each instance runs in a Firecracker microVM. https://developers.cloudflare.com/containers/concepts/architecture/

### Lifecycle
- Cold start is often 1 to 3 s; it grows with image size and entrypoint work. A fat ffmpeg + exiftool + libraw image (several hundred MB) will sit at the slow end of that range. https://developers.cloudflare.com/containers/faq/
- `Container` class `sleepAfter` defaults to `"10m"` and accepts seconds or `"30s"`/`"5m"`/`"1h"`. Activity resets it; `renewActivityTimeout()` resets it by hand. https://developers.cloudflare.com/containers/api/container-class/
- There is no fixed max runtime, but host restarts happen: SIGTERM, wait up to 15 min, then SIGKILL. Jobs must be idempotent and retryable.
- Durable Object and container are not guaranteed to be in the same location.
- No built-in autoscaling. Use `getRandom(env.MEDIA, N)` across N stateless instances, or explicit IDs. https://developers.cloudflare.com/containers/configuration/scaling-and-routing/

### APIs and Worker-to-container calls
- Two APIs exist. The `@cloudflare/containers` `Container` class (DO subclass with `defaultPort`, `sleepAfter`, `fetch()`, `containerFetch()`, `startAndWaitForPorts()`, hooks `onStart/onStop/onError/onActivityExpired`) and the newer Durable Object Container API (`ctx.container.start()`, `exec()` with streamed stdin/stdout, `monitor()`, `setInactivityTimeout()`). Docs recommend the latter for new apps. https://developers.cloudflare.com/containers/api/durable-object-container/
- Scheduling policies: `default` (image and `instance_type` in wrangler config) and `durable_object` (public beta; image and size chosen in `ctx.container.start()`, needs Wrangler 4.136+). Policy is immutable per application. Use `default` here. https://developers.cloudflare.com/containers/configuration/scheduling-policy/
- Worker calls: `getContainer(env.MEDIA_CONTAINER, id).fetch(req)` or `getRandom(...)`, which go through the DO stub to the container port.
- Streaming a 2 GB body Worker to container: the bodies are `ReadableStream`s and the docs show streaming `exec()` stdin/stdout. There is no documented size limit on DO stub fetch bodies. UNVERIFIED for multi-GB. The design below avoids it: the container pulls bytes from R2 itself.
- Container `exec()` `output()` buffers everything in DO memory (128 MB Worker limit). Stream large output instead.

### Bindings and outbound network
- Containers cannot use bindings directly, but outbound handlers give them binding access without credentials. `MyContainer.outboundByHost = { "media.r2": async (req, env, ctx) => ... env.MEDIA.get(key, { range }) }`. The container calls `http://media.r2/<key>` and the handler runs in the Workers runtime with all bindings. Requires exporting `ContainerProxy`. https://developers.cloudflare.com/containers/configuration/workers-connections/ and https://developers.cloudflare.com/containers/configuration/outbound-traffic/
- Outbound handlers intercept ports 80/443 only. `interceptHttps = true` needs the container to trust `/etc/cloudflare/certs/cloudflare-containers-ca.crt`. Plain `http://media.r2/...` avoids TLS; traffic stays on the same machine.
- Internet egress is on by default. `enableInternet = false` plus `allowedHosts` or handlers locks it down; DNS then resolves only covered hostnames.
- Alternatives: R2 S3 API with an API token passed as a secret env var, or FUSE mount of R2 (tigrisfs example, needs S3 creds, slower than local disk). https://developers.cloudflare.com/containers/examples/r2-fuse-mount/
- Handler execution limits (CPU, wall time, body size per intercepted request) are not documented. UNVERIFIED. Ranged reads of a few MB each stay well inside normal Worker limits.

### Local dev
- `wrangler dev` builds the Dockerfile and runs containers in a local Docker engine (Docker Desktop or Colima). `max_instances` is ignored locally. Press `r` to rebuild the container. Outbound interception works locally through a TPROXY sidecar. https://developers.cloudflare.com/containers/guides/local-dev/
- The Mac runs out of Docker memory fast. Build and test the image on a Linux x86_64 Docker host; on the Mac use Colima with a raised memory limit, or stub the container in Worker unit tests.
- Images build for amd64; on Apple Silicon this runs under emulation and is slow.

### Wrangler config shape (https://developers.cloudflare.com/containers/configuration/wrangler/)
```jsonc
{
  "containers": [
    { "class_name": "MediaContainer", "image": "./containers/media/Dockerfile",
      "instance_type": "standard-1", "max_instances": 3 }
  ],
  "durable_objects": { "bindings": [ { "name": "MEDIA_CONTAINER", "class_name": "MediaContainer" } ] },
  "exports": { "MediaContainer": { "type": "durable-object", "storage": "sqlite" } }
}
```
- New apps use `exports`. Existing apps with a `migrations` array may keep it (`new_sqlite_classes: ["MediaContainer"]`), but `exports` and `migrations` cannot be combined. Check which one the project already uses.
- Workers Builds on non-production branches run `wrangler versions upload`, which does not update container images, and container Workers get no preview URLs.

### Queue consumer limits
- Queue consumer wall time: 15 min per invocation. CPU time: 30 s default, configurable to 5 min via `limits.cpu_ms`. Time spent awaiting a fetch counts toward wall time but not CPU. https://developers.cloudflare.com/queues/platform/limits/
- So a consumer that awaits `container.fetch()` for a long ffmpeg job is cut off at 15 min. Poster and probe jobs using ranged reads take seconds, so this is fine for them. For long jobs (full transcode, if added later): start the job and return 202, have the container post the result back through an outbound handler (`http://callback.internal/...`) that writes D1, or run the step in Workflows (step wall time unlimited).
- HTTP-triggered Workers have no wall limit while the client stays connected. Cron and DO alarms: 15 min. https://developers.cloudflare.com/workers/platform/limits/

### Images binding limits (shape the RAW/large-image path)
- `env.IMAGES.input()` accepts up to 20 MB. https://developers.cloudflare.com/images/optimization/binding/
- 100 MP max area, 12,000 px max dimension (AVIF output 1,200 px). https://developers.cloudflare.com/images/get-started/limits/
- So the container must emit a JPEG under 20 MB and under 100 MP. Resize to 4,000 to 8,000 px on the long edge in the container and let the binding make the thumbnail sizes, or have the container write the preview and thumbnail directly.

## 2. ffmpeg with MOV/MP4 over HTTP Range

- MOV/MP4 demuxing needs the `moov` atom (sample tables). With moov at the end and a non-seekable input, ffmpeg must buffer through `mdat` and often fails ("moov atom not found"). https://trac.ffmpeg.org/wiki/HowToCheckIfFaststartIsEnabledForPlayback
- iPhone camera recordings write `ftyp`, `wide`, `mdat`, then `moov` at the end, because the recorder writes the index after capture. No Apple doc states this; it matches the common camera layout described at https://fabiensanglard.net/mobile_progressive_playback/index.php . Treat moov-at-end as the normal case and verify on a sample with `ffprobe -v trace` or `MP4Box -info`.
- FFmpeg's http protocol supports Range seeking (`seekable` defaults to -1, autodetect from server response). Options that cut round trips: `-multiple_requests 1` (keep-alive), `-initial_request_size` ("useful for formats like MXF or MOV that require frequent seeks during header parsing"), `-request_size` with `-short_seek_size` set equal or higher. https://ffmpeg.org/ffmpeg-protocols.html#http
- With a seekable HTTP source, `ffprobe` reads the top-level atom headers, seeks to the tail for moov, and reads only that. Poster extraction (`-ss 0 -frames:v 1` or `-ss 1`) then reads one keyframe's bytes from mdat. Total transfer is moov (a few hundred KB to a few MB for long 4K clips) plus one GOP's start. A 2 GB file does not need to be copied to disk.
- The server must return `206` with correct `Content-Range` and `Accept-Ranges: bytes`, and honour open-ended ranges (`bytes=N-`). An outbound handler built on `env.MEDIA.get(key, { range: request.headers })` plus `head()` for size can do this; set `Content-Length` and `Content-Range` from the returned object's `range` and `size`. ffmpeg may open several open-ended ranges and abort them; R2 `get` returns a stream, so an aborted read costs one Class B op and little transfer.
- Metadata from ffprobe: `format.duration`, stream `width/height`, rotation from `side_data_list` (Display Matrix) or the `rotate` tag, `creation_time`, Apple tags `com.apple.quicktime.creationdate` (has the local offset) and `com.apple.quicktime.location.ISO6709` (GPS). exiftool also reads MOV over a pipe but scans sequentially, so use ffprobe for video and keep exiftool for images.
- HEVC 10-bit HDR (iPhone default) needs an ffmpeg build with libx265 decode (native hevc decoder is enough for decoding) and a tonemap (`zscale` + `tonemap`, needs libzimg) for a correct SDR poster. Without tonemap the poster looks washed out.

## 3. The 100 MB request body limit

- Limit is per Cloudflare zone plan: Free 100 MB, Pro 100 MB, Business 200 MB, Enterprise self-serve up to 5 GB (more via account team). Exceeding returns 413. https://developers.cloudflare.com/workers/platform/limits/ and https://developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-413/
- `workers.dev` is treated as a Free website, so 100 MB applies there. https://developers.cloudflare.com/workers/configuration/routing/workers-dev/
- Custom domain on Free/Pro: 100 MB, same as workers.dev. Business: 200 MB, which does not cover a 2 GB video.
- No Workers-native workaround: the limit applies at the edge before the Worker runs, so Containers and Durable Objects behind the Worker do not help. Containers accept no direct inbound traffic; every request passes through a Worker. https://developers.cloudflare.com/containers/concepts/architecture/
- Cloudflare Tunnel: tunnel hostnames are proxied (orange cloud) DNS records, so the plan limit applies. Cloudflare's own guidance is "break up requests into smaller chunks, change your DNS record to DNS-only, or upgrade your plan". Community reports confirm 100 MB failures through tunnels on Free.
- Spectrum: custom TCP/UDP (layer 4 pass-through, no HTTP body inspection) requires Enterprise with Spectrum as a paid add-on. HTTP/HTTPS Spectrum apps run through the layer 7 CDN path, so the body limit applies. https://developers.cloudflare.com/spectrum/ and https://developers.cloudflare.com/spectrum/reference/limitations/
- A DNS-only (grey cloud) record on a custom domain removes the limit but bypasses Cloudflare, so it must point at a non-Cloudflare origin (Fly). It cannot point at a Worker.

## 4. Fly.io ingest proxy

### Fly facts (https://fly.io/docs/about/pricing/, https://fly.io/docs/reference/regions/)
- No free tier for new orgs (trial: 2 h runtime or 7 days).
- shared-cpu-1x: 256 MB $2.19/month, 512 MB $3.69, 1 GB $6.70 (iad prices). Frankfurt is about 15% higher (1 GB: $7.73 in fra vs $6.70 in iad).
- Stopped machines: $0.15 per GB of rootfs per 30 days. Auto-stop/auto-start through Fly Proxy cuts compute to running time; first request after stop adds a start delay of about a second (UNVERIFIED; the pricing doc gives no figure).
- Inbound transfer free. Egress to the internet from NA/EU: $0.02/GB. Fly to R2 counts as internet egress, so a 2 GB video costs $0.04 to forward.
- Shared IPv4 free, dedicated IPv4 $2/month, first 10 certificates free.
- Current regions near Cyprus: fra (Frankfurt), ams (Amsterdam), cdg (Paris), arn (Stockholm), lhr (London). `otp` (Bucharest) is no longer in the region list. Use fra.

### Shared constraint: the Immich app uses one server URL
- The mobile app sends every API call to one base URL, so the upload host and API host are the same. Options: point the app at a DNS-only custom domain on Fly that streams `POST /api/assets` to R2 and reverse-proxies everything else to the Worker, or point the app at Fly for everything. Either way all API traffic gains one hop through fra (small JSON calls, a few ms from fra to the Cloudflare edge).
- Check whether the current Immich mobile release has any chunked or resumable upload mode before building this. I found no doc confirming one. UNVERIFIED.

### Option A: Fly streams to R2 via the S3 API
- Fly parses the multipart body as a stream (busboy or similar), pipes the `assetData` part into `@aws-sdk/lib-storage` `Upload` (or aws4fetch with manual multipart) to `https://<account>.r2.cloudflarestorage.com`, then POSTs the form fields, R2 key, size and SHA-1 to an internal Worker endpoint that creates the asset row and returns the Immich response, which Fly relays.
- R2 multipart: parts 5 MiB to 5 GiB, all parts except the last the same size, max 10,000 parts, incomplete uploads aborted after 7 days. https://developers.cloudflare.com/r2/objects/upload-objects/ and https://developers.cloudflare.com/r2/platform/limits/
- Memory is about `partSize * queueSize`. 16 MiB x 4 = 64 MiB fits a 256 to 512 MB machine.
- Secrets on Fly: R2 access key ID and secret (token scoped to the one bucket, Object Read & Write) plus a shared secret for the Worker callback. Both set with `fly secrets set`, values from a secret manager.
- Reliability: lib-storage retries each part; failure aborts the multipart upload. SDK is mature. Cost: Class A ops per part ($4.50/M), trivial.

### Option B: Fly chunks to a Worker that uses the R2 binding
- Fly cuts the stream into fixed-size parts (for example 90 MiB, under the 100 MB edge limit) and POSTs each to `/internal/ingest/part?uploadId=..&n=..` on the Worker, which calls `env.MEDIA.resumeMultipartUpload(key, uploadId).uploadPart(n, request.body)`. Worker creates and completes the upload in separate calls. https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
- `uploadPart` accepts a `ReadableStream`, but it needs a known length. An incoming `request.body` with `Content-Length` works; a constructed stream needs `FixedLengthStream`. https://developers.cloudflare.com/workers/runtime-apis/streams/transformstream/
- Parts must be uniform except the last. Fly does not know where the stream ends, so it must buffer each part fully (90 MiB in RAM or on disk) before sending, both to set `Content-Length` and to retry. That needs a 512 MB to 1 GB machine.
- Secrets on Fly: one shared secret only. No R2 credentials outside Cloudflare.
- Each part is a Worker invocation (Workers request pricing, negligible). More code: upload state, part ordering, complete/abort, cleanup.

### Comparison

| | A: S3 API | B: chunks to Worker |
| --- | --- | --- |
| Code on Fly | Small (SDK) | Larger (chunker, buffering, retry) |
| Code on Worker | One "register asset" endpoint | create/part/complete/abort endpoints plus register |
| Fly machine | 256 to 512 MB | 512 MB to 1 GB |
| Fly egress | $0.02/GB | $0.02/GB |
| Secrets on Fly | R2 key pair + callback secret | Callback secret |
| Latency | Streaming, parts in parallel | Store-and-forward per 90 MiB part |
| Failure handling | SDK retries parts | Own retry logic |

## 5. Alternatives without extra hosting

- Enterprise plan: raises the limit to 5 GB self-serve. Only full fix inside Cloudflare; cost is far above Fly.
- R2 presigned PUT URLs (1 s to 7 days expiry, S3 API host, no 100 MB edge cap since the host is `r2.cloudflarestorage.com`): needs a client that requests a URL first. The Immich app does not. https://developers.cloudflare.com/r2/api/s3/presigned-urls/
- Business plan: 200 MB covers HEIC, RAW and short clips. 4K video still fails.
- A different Immich client (or a small upload helper on the phone) that chunks would remove the cap, but that changes the client, which the project is avoiding.
- No Cloudflare product (Workers, DO, Containers, Tunnel, HTTP Spectrum) lifts the limit on Free/Pro.

## Recommended designs

### (a) Media container
- One `MediaContainer` class on the `default` scheduling policy, `standard-1` (0.5 vCPU, 4 GiB, 8 GB disk), `max_instances` 2 to 3, `sleepAfter` "5m", routed with `getRandom` or by job ID. Raise to `standard-2` only if HEVC decode or RAW demosaic times are too slow.
- Image: Debian slim with ffmpeg (hevc decode, zscale/tonemap), exiftool, libraw (`dcraw_emu`) or libvips with libraw. Keep it small to hold the cold start near 1 to 3 s. Build on an amd64 host.
- Container reads source bytes through an outbound handler `http://media.r2/<key>` backed by the `MEDIA` binding with Range support. No R2 credentials in the container. Set `enableInternet = false`, allow only the virtual hosts.
- Video: `ffprobe -multiple_requests 1 -initial_request_size 65536 http://media.r2/<key>` for metadata; `ffmpeg ... -ss 1 -frames:v 1` poster with HDR tonemap, scaled to 1440 px long edge, JPEG under 20 MB. No full download for moov-at-end files.
- RAW and images over 20 MB: download to local disk (DNG/CR3/NEF/ARW files are tens of MB, well inside 8 GB), decode, resize so the result is under 20 MB and 100 MP, write the JPEG back through a `PUT http://media.r2/<derived-key>` handler, return JSON metadata. Worker then runs the Images binding on the derived JPEG.
- Trigger from the existing Queue consumer: consumer awaits `container.fetch("/probe" | "/poster" | "/raw")`. These jobs finish in seconds, under the 15 min consumer wall limit. Set `limits.cpu_ms` only if the consumer itself does heavy work. Make jobs idempotent (host restarts send SIGTERM).
- Limits that shape it: Images input 20 MB and 100 MP, instance disk 8 GB on standard-1, 15 min consumer wall time, outbound handlers on ports 80/443 only, Docker needed for local dev.

### (b) Large-upload ingest
- Option A on Fly in fra: one shared-cpu-1x 512 MB machine with auto-stop/auto-start (about $0.60 to $4.30/month depending on uptime, plus $0.02/GB egress).
- A DNS-only custom domain (for example `photos.<domain>`) points at Fly. Fly streams `POST /api/assets` multipart straight to R2 via lib-storage (16 MiB parts, queue 4), hashes SHA-1 on the way, then calls a Worker internal endpoint (shared-secret auth) to create the asset row and enqueue processing. Every other path is reverse-proxied to the Worker.
- Uploads under 100 MB can still go straight to the Worker if the app is pointed at the Worker, but the single-URL client means Fly fronts everything once it is the server URL.
- Limits that shape it: Cloudflare edge 100 MB on Free/Pro including workers.dev and Tunnel; R2 parts uniform except last, 5 MiB min, 10,000 max; R2 token scoped to one bucket; Fly has no free tier and no `otp` region.
- Option B only if keeping R2 credentials off Fly outweighs the extra code and memory.

## Sources
- https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/
- https://developers.cloudflare.com/containers/platform/limits/
- https://developers.cloudflare.com/containers/platform/pricing/
- https://developers.cloudflare.com/containers/faq/
- https://developers.cloudflare.com/containers/concepts/architecture/
- https://developers.cloudflare.com/containers/api/container-class/
- https://developers.cloudflare.com/containers/api/durable-object-container/
- https://developers.cloudflare.com/containers/configuration/scheduling-policy/
- https://developers.cloudflare.com/containers/configuration/scaling-and-routing/
- https://developers.cloudflare.com/containers/configuration/workers-connections/
- https://developers.cloudflare.com/containers/configuration/outbound-traffic/
- https://developers.cloudflare.com/containers/configuration/wrangler/
- https://developers.cloudflare.com/containers/guides/local-dev/
- https://developers.cloudflare.com/containers/examples/r2-fuse-mount/
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/workers/configuration/routing/workers-dev/
- https://developers.cloudflare.com/queues/platform/limits/
- https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
- https://developers.cloudflare.com/r2/objects/upload-objects/
- https://developers.cloudflare.com/r2/platform/limits/
- https://developers.cloudflare.com/r2/pricing/
- https://developers.cloudflare.com/r2/api/s3/presigned-urls/
- https://developers.cloudflare.com/images/optimization/binding/
- https://developers.cloudflare.com/images/get-started/limits/
- https://developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-413/
- https://developers.cloudflare.com/spectrum/
- https://developers.cloudflare.com/spectrum/reference/limitations/
- https://ffmpeg.org/ffmpeg-protocols.html#http
- https://trac.ffmpeg.org/wiki/HowToCheckIfFaststartIsEnabledForPlayback
- https://fabiensanglard.net/mobile_progressive_playback/index.php
- https://fly.io/docs/about/pricing/
- https://fly.io/docs/reference/regions/
