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

You need a Cloudflare account on [Workers Paid](https://developers.cloudflare.com/workers/platform/pricing/) ($5/month, includes Containers). Nothing to build: the web app and the container images are prebuilt.

### One click

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/krugerm/immich-cloudflare)

1. Click the button, sign in to Cloudflare and connect GitHub (a copy of this repo is created in your account).
2. Keep the defaults, except the two Vectorize indexes, which the form leaves blank:

   | Binding | Dimensions | Metric |
   |---|---|---|
   | `CLIP_INDEX` | `768` | `cosine` |
   | `FACE_INDEX` | `512` | `cosine` |

   The metric must be `cosine` for both: search, duplicate detection and face grouping compare embeddings by cosine similarity, and `euclidean` or `dot-product` give wrong results. An index's dimensions and metric cannot be changed after it is created.

   Press **Deploy**. D1, R2, Queues, Vectorize and the containers are created for you.
3. Open the `*.workers.dev` URL when the build finishes, create the admin account, and enter the same URL in the Immich app.

### Command line

```sh
git clone https://github.com/krugerm/immich-cloudflare && cd immich-cloudflare
npm ci
npx wrangler login
npm run build     # downloads the prebuilt Immich web app into public/
npm run deploy    # about 2 minutes: creates every resource, deploys, applies the database migrations
```

Then open the URL that `deploy` prints, create the admin account, and log in from the Immich app.

The containers start on first use: the first upload's thumbnails, faces and search index take a few minutes while Cloudflare pulls the images, and later ones take seconds. Running `npm run deploy` again is safe and updates the deployment.

### Optional

- **Custom domain:** add `"routes": [{ "pattern": "photos.example.com", "custom_domain": true }]` to `wrangler.jsonc` and deploy again.
- **Password reset email:** `npx wrangler secret put RESEND_API_KEY`, and set `MAIL_FROM` to an address on a domain verified in [Resend](https://resend.com).
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

## Licence

[AGPL-3.0](LICENSE). Attributions for Immich, GeoNames and the ML models are in [NOTICE.md](NOTICE.md). The InsightFace `buffalo_l` face models are licensed for non-commercial research use only.
