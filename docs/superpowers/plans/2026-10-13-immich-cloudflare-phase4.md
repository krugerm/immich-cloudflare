# Phase 4: Smart Search, Faces, Duplicates, Places Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Searching "beach" returns beach photos; faces are detected and grouped into people the apps can name and browse; near-duplicates are listed and resolvable; photos with GPS get city, state, country and a GPS-derived time zone.

**Architecture:** A new `asset-ml` queue runs after an asset is `ready`. Its consumer sends the asset's preview JPEG to an `ml` Container built from Immich's own machine-learning image (`ghcr.io/immich-app/immich-machine-learning:v3.3.1`, models baked in), which returns a SigLIP2 image embedding and buffalo_l faces in one `/predict` call. Embeddings are kept in D1 (source of truth) and in two Vectorize indexes (search/duplicates, faces). A `ClusterHub` Durable Object per cluster group groups faces into people in strict order. Reverse geocoding uses a GeoNames table in D1; time zones come from `@photostructure/tz-lookup` in the Worker.

**Tech Stack:** Workers, D1, R2, Queues, Vectorize, Durable Objects, Containers, Images binding.

**Spec:** `docs/superpowers/specs/2026-10-12-immich-cloudflare-design.md` (section 9 phase 4). Research (binding for details; read the sections each task names): `docs/research/2026-10-13-phase4-embeddings.md`, `docs/research/2026-10-13-phase4-faces.md`, `docs/research/2026-10-13-phase4-search-duplicates.md`, `docs/research/2026-10-13-phase4-geocoding.md`, `docs/research/2026-10-13-face-models.md`.

## Global Constraints

- Search/duplicate model: `ViT-B-16-SigLIP2__webli` (user decision 2026-10-13), 768-d, cosine. Face model: `buffalo_l`, 512-d, Immich defaults (minScore 0.7, maxDistance 0.5, minFaces 3).
- Contract files from Task 0 are fixed: `src/ml/contract.ts`, `src/ml/vectors.ts`, `src/ml/job.ts` (dispatch). Changes go through the controller.
- Vectors: D1 holds every embedding (`smart_search.embedding` 768 x float32 LE, `face_embeddings.embedding` 512 x float32 LE). Vectorize is an index rebuilt from D1 when needed. Code reaches Vectorize only through `vectorStore(env, 'clip' | 'face')` from `src/ml/vectors.ts`; tests use its in-memory fake.
- Vectorize limits shape the API: topK at most 100 (50 with metadata); writes are visible after a few seconds. Smart search returns at most the top 100 matches.
- One cluster group per user (`cluster_group_id = users.id`); no person sharing; cluster-group and `/people/users` endpoints stay unbuilt.
- Synced rows (`people`, `asset_faces`, `assets`, `asset_exif`) are written only through `tracked()`/`commit()`, one row per statement. Foreign-key actions never replace an explicit audited write.
- Migrations: Task 0 creates every phase 4 table (`0100`–`0103`). A stream that needs another migration uses its range: B `0120`–`0124`, C `0125`–`0129`, D `0130`–`0134`, E `0135`–`0139`, F `0140`–`0144`, G `0145`–`0149`.
- Docker runs on a Linux x86_64 build host only, batched into few SSH sessions.
- `npx vitest run --testTimeout=60000` and `npx tsc --noEmit` green before every commit. Plain commit messages, no AI attribution or Co-Authored-By lines. No deploys, no Cloudflare commands, no subagents, no git stash.

## Review Focus

1. A face assigned or renamed by hand survives every later automatic pass (only a forced re-cluster may reset machine assignments, as Immich does). Test in Task E.
2. A purged or trashed asset disappears from smart search, duplicates and people counts, and its vectors leave Vectorize; a restored one comes back. Tests in Tasks B, C, G.
3. Search for one user never returns another user's assets (Vectorize filter by owner plus a D1 re-check). Test in Task B.
4. A photo whose EXIF already has an offset keeps it; GPS time zone fills only missing ones, and `local_date_time` does not move for wall-clock EXIF times. Test in Task F.
5. The ML container down or cold (5xx, timeout) retries the job and never marks the asset failed or deletes faces. Tests in Tasks A and D.

## Execution shape

Task 0 (controller) commits contracts, migrations and bindings. Tasks A to G run in parallel, one worktree each. Task H (controller) integrates, deploys and backfills.

| Task | Owns |
|---|---|
| A | `containers/ml/**`, `src/ml/client.ts`, `src/ml/hub.ts` (MlContainer class), `test/ml-client.test.ts` |
| B | `src/ml/clip.ts`, `src/search/smart.ts` (new), `src/search/routes.ts` (smart route lines only), `test/smart-search.test.ts` |
| C | `src/duplicates/**` (new), `src/assets/routes.ts` (remove the `/duplicates` stub only), `test/duplicates.test.ts` |
| D | `src/faces/store.ts`, `src/faces/thumbs.ts`, `src/sync/passes/faces.ts`, `src/sync/passes.ts` (register lines only), `test/faces-store.test.ts`, `test/faces-sync.test.ts` |
| E | `src/faces/cluster.ts`, `src/faces/hub.ts` (ClusterHub DO), `src/people/**` (new routes), `src/assets/routes.ts` (remove `/people` and `/faces` stubs only), `src/search/routes.ts` (`/search/person` lines only), `src/search/criteria.ts` (personIds lines only), `src/timeline/routes.ts` (personId lines only), `test/people*.test.ts`, `test/cluster.test.ts` |
| F | `src/geo/**` (new), `scripts/geodata/**`, `src/process/exif.ts` and `src/process/consumer.ts` (geocode/timezone call sites only), `src/map/**`, `src/search/routes.ts` (places/cities/suggestions lines only), `test/geo*.test.ts` |
| G | `src/jobs/routes.ts`, `src/cron/index.ts`, `src/cron/purge.ts` + `src/cron/purge-users.ts` (vector cleanup lines only), `src/server/routes.ts` (feature flags), `README.md`, `test/ml-jobs.test.ts` |

Shared files edited by several streams (`src/search/routes.ts`, `src/assets/routes.ts`, `src/app.ts`) take only the lines named; register new route modules in `src/app.ts` in one block with a `// phase 4 <task>` comment.

---

### Task 0: Contracts, migrations, bindings (controller)

Commits on branch `phase4` before streams start:
- `src/ml/contract.ts`: `MlClient` with `predict(image: Uint8Array, want: { clip: boolean; faces: boolean }): Promise<MlImageResult>` and `embedText(text: string): Promise<number[]>`; `MlImageResult = { clip: number[] | null; faces: MlFace[] | null; imageWidth: number; imageHeight: number }`; `MlFace = { boundingBox: { x1; y1; x2; y2 }; score: number; embedding: number[] }`; `MlUnavailableError` (retry) and `MlInputError` (terminal).
- `src/ml/vectors.ts`: `VectorStore` (`upsert(items)`, `query(vector, { topK, namespace?, filter? })`, `deleteByIds(ids)`), `vectorStore(env, kind)` returning the Vectorize-backed store, or an in-memory fake when `env.TEST_FAKE_VECTORS === 'true'` (set in vitest).
- `src/ml/job.ts`: `processMl(env, assetId, ml, opts)`: loads the asset and its preview, calls `ml.predict`, then `storeClip` (Task B, `src/ml/clip.ts` stub) and `storeFaces` (Task D, `src/faces/store.ts` stub), then stamps `assets.ml_at`. Queue `asset-ml` consumer wired in `src/index.ts`; `markReady` enqueues `{assetId}` when `env.ML_QUEUE` is bound.
- Migrations `0100_faces.sql` (faces report section 5.2 schema), `0101_smart_search.sql` (`smart_search(asset_id PK, embedding BLOB, model TEXT)`, `assets.ml_at`, `assets.duplicate_id`, `assets.duplicates_checked_at`), `0102_geodata.sql` (geocoding report schema: `geodata_places` with cell index), `0103_ml_state.sql` (whatever job cursors Task G needs: `ml_job_state(name PK, value)`).
- wrangler: queue `asset-ml` (producer `ML_QUEUE`, consumer max_batch_size 5, retries 5, DLQ `asset-ml-dlq`), Vectorize `CLIP_INDEX` (`immich-clip`, 768 cosine) and `FACE_INDEX` (`immich-faces`, 512 cosine), DO bindings `ML_CONTAINER` (class `MlContainer`) and `CLUSTER_HUB` (class `ClusterHub`), migration tag `v3-ml` with both classes. Test config strips Vectorize and the ML container like phase 3 strips containers.

---

### Task A: ML container and client

Read: embeddings report (setup, Immich ML API), search report section 1 (`/predict` request shape), faces report sections on detection inputs.
- `containers/ml/Dockerfile`: `FROM ghcr.io/immich-app/immich-machine-learning:v3.3.1`; bake `ViT-B-16-SigLIP2__webli` (visual + textual) and `buffalo_l` (detection + recognition) into the image's model cache at build time (no internet at runtime); env for model TTL off, one worker, port 3003; build check that both models load.
- `src/ml/hub.ts`: `MlContainer extends Container`, `defaultPort 3003`, `sleepAfter '10m'`, `enableInternet false`, instance `standard-2`, `max_instances 2`.
- `src/ml/client.ts`: `mlClient(env): MlClient | undefined` posting multipart `/predict` exactly as Immich's `machine-learning.repository.ts` does (entries JSON for `clip.visual` and `facial-recognition` detection/recognition with `minScore 0.7`; text via `clip.textual`), parsing Immich's response shapes into `MlImageResult`; 5xx/timeout (60 s) → `MlUnavailableError`; 422/400 image errors → `MlInputError`.
- Tests: client against a fake namespace (request multipart fields and entries JSON match Immich's; response parsing; error mapping). Container: build on the build host and run a smoke script that posts a public-domain photo with one face and a text query, asserting 768-d clip, at least one face with a 512-d embedding, and text 768-d. Paste output in the report.

### Task B: Smart search

Read: search report sections 1, 2, 4.
- `storeClip(env, asset, embedding)`: upsert `smart_search` (float32 BLOB) and `vectorStore(env,'clip').upsert({ id: asset.id, values, metadata: { ownerId } })`.
- `POST /search/smart`: Immich DTO and response (`SearchResponseDto`, `assets.nextPage`), text embedding via `mlClient.embedText` (cache last 200 query embeddings in memory per isolate), Vectorize query topK 100 with `ownerId` in (user + partners with timeline sharing, as metadata search scopes), then D1 re-check of ownership, visibility, trash and the request filters, keep Vectorize order, paginate within the 100. `queryAssetId` searches by an asset's stored embedding. Feature flag `smartSearch` true when `ML_CONTAINER` is bound.
- Tests with the fake vector store and a fake ML client: ranking order, owner isolation, partner inclusion, trashed/archived/locked handling as Immich, pagination and nextPage, `queryAssetId`, 400s.

### Task C: Duplicates

Read: search report section 3 and 4.
- Detection: a function `detectDuplicates(env, ownerId, limit)` processes assets with `smart_search` rows, `duplicates_checked_at` null and `ml_at` older than 60 s (Vectorize visibility), querying topK 64 within the threshold, same owner only, Immich's group merging via `duplicate_id` (write `assets` rows through `tracked`, since `assets` is a synced table even though `duplicateId` is absent from sync). Threshold: SigLIP2 cosine distance `0.03` as a starting value; record in the report how it was chosen and make it a config value (`machineLearning.duplicateDetection.maxDistance`).
- `GET /duplicates`, `DELETE /duplicates`, `DELETE /duplicates/{id}`, `POST /duplicates/resolve` with Immich's semantics (resolve merges favourite, visibility, rating, description, location, albums, tags onto the kept asset, trashes the rest).
- Tests: grouping, merging of groups, owner isolation, resolve effects, trashed assets excluded.

### Task D: Face storage, thumbnails, sync

Read: faces report sections 1, 2, 4, 5.
- `storeFaces(env, asset, result)`: Immich's IoU > 0.5 matching against existing faces of the asset; insert new `asset_faces` (boxes in preview pixel space with image width/height), `face_embeddings`, `vectorStore(env,'face').upsert({ id: faceId, values, namespace: clusterGroupId })`; soft-delete machine faces no longer detected (manual/exif faces untouched); then notify `CLUSTER_HUB` (one call per cluster group with the new face ids; Task E implements the DO, Task 0 stubs it).
- Person thumbnails: `renderPersonThumbnail(env, personGroupId)` crops the face from `thumbs/<asset>/preview.jpeg` with a 10% margin to 250 px JPEG via the Images binding, stores at `people/<personGroupId>.jpeg`. Task G deletes that object when a person is purged.
- Sync passes for the types the 3.3 mobile app requests (faces report section 4: `AssetFacesV3` scoped to the cluster group, `PeopleV1`/person deletes), registered in `SYNC_TYPES_ORDER` position.
- Tests: IoU matching, soft-delete of vanished faces, manual faces kept, sync lines validate against the contract, thumbnail crop math.

### Task E: Clustering and people API

Read: faces report sections 1 (clustering algorithm), 3 (API), 5.
- `ClusterHub` DO per cluster group: Immich's incremental clustering (core faces: at least `minFaces` neighbours within `maxDistance` on timeline assets; non-core deferred to a second pass that can only join an existing person), neighbour search via `vectorStore(env,'face').query` in the group namespace plus an in-DO buffer of faces written in the last 2 minutes (exact cosine), with D1 re-checks. Writes person groups and assignments through tracked statements. Forced re-cluster resets only machine assignments.
- People and Faces endpoints (faces report section 3 list): `GET/POST/PUT/DELETE /people`, `GET/PUT/DELETE /people/{id}`, merge, reassign, statistics, thumbnail, `GET/POST/PUT/DELETE /faces`, `GET /search/person`, `personIds` in metadata search and timeline. Permissions as Immich.
- Tests: clustering on synthetic embeddings (two people, noise faces, deferred faces), manual assignment survival, merge/reassign effects and audits, permissions, search by person.

### Task F: Places and time zones

Read: geocoding report in full.
- `scripts/geodata/build.mjs`: downloads GeoNames cities500, admin1, admin2, countryInfo (CC BY 4.0) and writes chunked SQL for `geodata_places` (cell index) to `scripts/geodata/out/` (gitignored); README note on importing with `wrangler d1 execute --remote --file` per chunk (Task H runs it).
- `reverseGeocode(db, lat, lon)`: nearest within 25 km via cell candidates and Haversine; fills `asset_exif.city/state/country` in the photo, video and large-image paths (one call in `markReady`'s inputs). Country fallback by polygon is out of scope (record it); return nulls beyond 25 km.
- Time zone: `@photostructure/tz-lookup` fills `timeZone` only when EXIF has no offset; `dateTimeOriginal` recomputed as the geocoding report describes; `local_date_time` unchanged for wall-clock EXIF.
- Endpoints: `GET /map/reverse-geocode`, `GET /search/places`, `GET /search/cities`, `/search/suggestions` country/state/city facets per the report.
- Backfill `backfillPlaces(env, limit)`: D1-only pass over assets with GPS and no city, tracked `asset_exif` updates.
- Tests with a small fixture of places; tz-lookup runs under workerd (assert a few known coordinates).

### Task G: Jobs, purge, flags

- Admin queues `smartSearch`, `faceDetection`, `facialRecognition`, `duplicateDetection` start/force enqueue `asset-ml` (or call the duplicate/cluster passes) as Immich's job semantics describe; statistics from D1 (`ml_at`, `duplicates_checked_at`, unassigned faces).
- Daily cron: enqueue up to 500 `ready` assets with `ml_at` null; run `detectDuplicates` for up to 2000 assets; `backfillPlaces` up to 5000.
- Purge (`purgeAssets`, `purgeUser`): delete `smart_search`, faces (with `asset_face_audit` rows) and their vector ids, under the same restore guard, vectors deleted after the commit like R2 objects (queue table or retry), people left without faces handled as Immich does.
- Server features: `smartSearch`, `facialRecognition`, `duplicateDetection`, `reverseGeocoding` true when their bindings exist. README section for phase 4 operations.
- Tests for each.

### Task H: Integrate, deploy, backfill (controller)

- Merge A to G; full suite and typecheck; whole-branch review.
- Create Vectorize indexes and the `asset-ml` queues (confirm before creating), import geodata into D1 (time it), deploy, smoke one photo (clip, faces, place), backfill all 1,653 assets, run clustering, check: "beach" query ranks beach photos, people appear in the web app, a GPS photo shows its city.
