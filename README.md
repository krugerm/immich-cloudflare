<div align="center">

# Immich on Cloudflare

**Your own [Immich](https://immich.app) photo server, running entirely on Cloudflare. No server to manage.**

[![Built with Cloudflare](https://workers.cloudflare.com/built-with-cloudflare.svg)](https://www.cloudflare.com/)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Immich API 3.3](https://img.shields.io/badge/Immich%20API-3.3-4250af.svg)](https://immich.app)

</div>

---

Immich on Cloudflare is a reimplementation of the Immich server on Cloudflare Workers. It speaks the Immich 3.3 API, so the **stock Immich iOS app and web app work unmodified**: point the app at your Worker URL and log in.

There is no VM, no Postgres and no Docker host to keep alive. Photos live in R2, the catalogue in D1, and machine learning runs in Cloudflare Containers that sleep when idle. A personal library costs a few dollars a month.

> Not affiliated with or endorsed by the Immich project or FUTO.

## Features

| | |
|---|---|
| 📱 **Backup** | Automatic background backup from the Immich iOS app |
| 🗂️ **Library** | Timeline, favourites, archive, trash, locked folder, albums, shared links, partner sharing |
| 🔎 **Smart search** | Search by what is in the photo ("beach at sunset"), using SigLIP2 |
| 🙂 **People** | Face detection and clustering (buffalo_l), merge and name people |
| 🧹 **Duplicates** | Near-duplicate detection with a review screen |
| 🗺️ **Places** | Reverse geocoding (GeoNames) and the map |
| 🎞️ **Media** | HEIC, RAW, video posters and metadata (ffmpeg, exiftool, libraw) |
| 💌 **Account** | Password reset by email (optional, via Resend) |

**Not yet:** video transcoding (videos play as uploaded), uploads over 100 MB, external libraries, OAuth. See [BACKLOG.md](BACKLOG.md).

## How it works

```
 Immich app / web ──▶ Worker (Hono)
                        ├── D1          users, assets, albums, faces, places
                        ├── R2          originals, thumbnails, backup copy
                        ├── Queues      processing, backup, machine learning
                        ├── Durable Objects  realtime events, face clustering
                        ├── Containers  media (ffmpeg/libraw) · ML (Immich ML) · search
                        └── Vectorize   photo embeddings, face embeddings
```

## Deploy to your Cloudflare account

**You need:** a Cloudflare account on [Workers Paid](https://developers.cloudflare.com/workers/platform/pricing/) ($5/month, includes Containers), Node.js 22+, and Docker on an x86_64 machine.

**1. Get the code**

```sh
git clone https://github.com/krugerm/immich-cloudflare && cd immich-cloudflare
npm ci && npx wrangler login
npm run build:web                  # builds the Immich web app into public/
```

**2. Create the Cloudflare resources**

```sh
npx wrangler d1 create immich      # copy the database_id it prints
npx wrangler r2 bucket create immich-media
npx wrangler r2 bucket create immich-originals-backup
for q in asset-process asset-process-dlq asset-backup asset-backup-dlq asset-ml; do npx wrangler queues create $q; done
npx wrangler vectorize create immich-clip  --dimensions=768 --metric=cosine
npx wrangler vectorize create immich-faces --dimensions=512 --metric=cosine
npx wrangler vectorize create-metadata-index immich-clip  --propertyName=ownerId  --type=string
npx wrangler vectorize create-metadata-index immich-faces --propertyName=assigned --type=string
```

**3. Configure**

```sh
cp wrangler.jsonc wrangler.local.jsonc   # gitignored: your values live here
```

In `wrangler.local.jsonc`, paste the `database_id`, and optionally add a custom domain under `routes` and set `APP_NAME` / `MAIL_FROM`.

**4. Build the search image** (the other two images build during deploy)

```sh
docker build --platform linux/amd64 --target search -t immich-cf-ml-search:v1 containers/ml
npx wrangler containers push immich-cf-ml-search:v1   # put the printed image URL in wrangler.local.jsonc
```

**5. Deploy**

```sh
npx wrangler d1 migrations apply immich --remote -c wrangler.local.jsonc
npm run deploy
openssl rand -base64 48 | npx wrangler secret put MEDIA_GRANT_SECRET -c wrangler.local.jsonc
```

**6. Open it.** Visit your Worker URL, create the admin account, then enter the same URL in the Immich app.

### Optional

- **Password reset email:** `npx wrangler secret put RESEND_API_KEY -c wrangler.local.jsonc`, with `MAIL_FROM` on a domain verified in [Resend](https://resend.com).
- **Place names:** import GeoNames once, see [scripts/geodata/README.md](scripts/geodata/README.md).
- **Existing photos:** after a bulk import, start the jobs under Administration → Job Queues. A daily cron also picks up anything missed.

## Costs

Roughly **$20–25/month for a 500 GB library**: Workers Paid ($5), R2 storage for originals plus a backup copy, and small amounts of container and Images usage. A small library costs little beyond the $5 plan. Check [Cloudflare pricing](https://www.cloudflare.com/plans/developer-platform/) for current rates.

## Development

```sh
npm test            # vitest in workerd
npx tsc --noEmit    # type check
npm run dev         # local server on :8787 (containers do not run locally)
```

The design and implementation notes are in [docs/](docs/).

## Licence

[AGPL-3.0](LICENSE). Attributions for Immich, GeoNames and the ML models are in [NOTICE.md](NOTICE.md). The InsightFace `buffalo_l` face models are licensed for non-commercial research use only.
