# Backlog

Work that is out of the current phases but may be picked up later.

## Video transcoding to H.264

Playback (`GET /assets/{id}/video/playback`) serves the original file. iPhone HEVC video plays in the iOS app, Safari and Chrome on macOS, but fails in Firefox and in Windows and Linux browsers without HEVC support. Fix: after upload, the phase 3 `media` container writes `encoded/<assetId>.mp4` (H.264 + AAC) and playback serves it when present. Cost: about double the video storage. Decided 2026-10-13: not in phase 3.

## Uploads over 100 MB (Fly ingest proxy)

Cloudflare rejects request bodies over 100 MB on Free/Pro plans and on workers.dev, and the Immich app sends each file in one POST, so longer 4K videos never back up. Design: a Fly machine in `fra` on a DNS-only custom domain fronts all app traffic, streams `POST /api/assets` to R2 over the S3 API with a bucket-scoped token, hashes SHA-1 on the way, registers the asset through a Worker endpoint, and reverse-proxies every other path to the Worker. About $2 to $5 a month. Open questions: the hostname, and token on Fly versus chunking through the Worker. Deferred 2026-10-13.

## Asset-files endpoints

`GET /asset-files`, `GET /asset-files/{id}`, `GET /asset-files/{id}/download`, `DELETE /asset-files/{id}`. Neither the web app nor the iOS app calls them. A read-only version lists the R2 keys generated per asset (thumbnail, preview, encoded video); about an hour.
