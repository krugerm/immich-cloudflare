# Phase 4 research: smart search, duplicate detection, Vectorize fit

Researched 2026-10-13. Immich citations are `path:line` under the read-only checkout at `<immich-source-checkout>` (written `immich/` below; server code is `immich/server/src/`, abbreviated `S/`). Cloudflare facts come from the docs URLs cited in section 4. Items marked UNVERIFIED have no doc source and need a spike.

## 0. Findings that change the plan

1. Immich 3.x has two request shapes for `/search/smart`. The flat shape (deprecated field set plus `page`) is what the stock web app and mobile app still send. The structured shape (`filter`, `cursor`) exists on the server but smart search returns no cursor in it. Implement the flat shape fully and accept the structured shape.
2. Vectorize returns at most 100 matches per query (50 with values or metadata). Immich's smart search pages by `page` and `size` with OFFSET over the whole ranked set. Page depth beyond rank 100 is not reachable with Vectorize alone (section 4.6).
3. `duplicateId` is not in `SyncAssetV2`, so writing it needs no sync cursor bump. It is in `AssetResponseDto`, which the web duplicates page reads.
4. Duplicate detection runs only on assets whose smart-search job ran with `source: 'upload'`, or from the admin queue. It needs the CLIP-style image embedding and a distance threshold tuned to the model. Immich's default `0.01` is tuned for ViT-B-32; EmbeddingGemma 2 needs its own calibration.
5. Face clustering is a serial algorithm that reads its own just-written results. Vectorize's asynchronous writes break that. Section 4.7 recommends exact search inside the `ml` Container for faces.
6. The text query must be embedded by the same model as the images. That means a Container call per uncached query. Cold start (1 to 3 s plus model load) is the main latency risk for smart search, larger than the Vectorize query (median 30 ms per Cloudflare's 2024 GA post).

## 1. Smart search in Immich

### 1.1 Endpoint and DTO

`POST /search/smart`, permission `asset.read`, HTTP 200, shared links not allowed (`S/controllers/search.controller.ts:82-92`). Returns `SearchResponseDto`.

Request `SmartSearchDto` (`S/dtos/search.dto.ts:51-60`):

| Field | Type | Notes |
|---|---|---|
| `query` | string, trimmed, optional | Natural language text |
| `queryAssetId` | uuidv4, optional | Similar-image search by an existing asset |
| `language` | string, optional | Weblate locale code, for example `de` or `pt-BR` |
| `size` | int 1..1000, default 100 | Overrides the base default of 250 (`:53`) |
| `page` | int >= 1, optional | Deprecated flat field |
| `withExif` | boolean, optional | Include exif in each asset |
| `withDeleted` | boolean, optional | Deprecated flat field (`:71`) |
| flat filters | many | `type, visibility, isFavorite, isMotion, isOffline, isEncoded, libraryId, createdBefore/After, updatedBefore/After, trashedBefore/After, takenBefore/After, city, state, country, make, model, lensModel, isNotInAlbum, personIds, tagIds, albumIds, rating, ocr` (`:25-68`) |
| `filter` | `SearchFilter`, optional | Structured shape (`:16`, `:200-297`) |

The structured `SearchFilter` has per-field operator objects (`eq, ne, in, notIn`, range operators, `any/all/none` for id lists) plus an `or` array of branches (`:248-297`). Structured and flat fields are mutually exclusive; a request that sets `filter`, `orderBy` or `cursor` and also a deprecated field fails validation (`:113-143`). `isNewShapeRequest` checks `filter`, `orderBy`, `cursor` only (`:112-116` of that block, exported at about `:312`).

Response `SearchResponseDto` (`:425-466`): `{ albums: {total, count, items, facets}, assets: {total, count, items, facets, nextPage: string|null, nextCursor: string|null} }`. `total` is deprecated and equals the page count. For smart search `albums` is always empty (`S/services/search.service.ts:369-382`).

### 1.2 Service flow (flat shape)

`S/services/search.service.ts:168-198`:

1. If the request is structured, delegate to `searchSmartV3` (`:169-171`, `:281-300`).
2. `visibility = locked` requires an elevated session (`:173-175`).
3. Load config without cache; if `!isSmartSearchEnabled` throw 400 `Smart search is not enabled` (`:177-180`). `isSmartSearchEnabled` is `machineLearning.enabled && machineLearning.clip.enabled` (`S/utils/misc.ts:97-98`).
4. `userIds = getUserIdsToSearch` (`:356-367`): the caller plus partners whose timeline sharing is on; only the caller when `visibility = locked`.
5. `resolveEmbedding` (`:325-354`):
   - If `query` is truthy: cache key is `clip.modelName + query + language` in a 100-entry LRU (`:36`, `:331`); on miss call `machineLearningRepository.encodeText(query, {modelName, language})`.
   - Else if `queryAssetId`: `requireAccess(AssetRead)` on that asset (partner assets pass), read its row from `smart_search`, else 400 `Asset <id> has no embedding`.
   - Else 400 `Either query or queryAssetId must be set`. `query` wins when both are set.
6. Run `searchRepository.searchSmart({page, size}, {...dto, userIds, viewingUserId, embedding, visibility})` where visibility defaults to `'not-locked'` unless the session is elevated (`:193`).
7. `nextPage = hasNextPage ? String(page + 1) : null` (`:197`).

Structured path (`:281-300`): same enabled check, `resolveSearchScopeV3` (`:302-323`) builds the scope `{userIds, lockedOwnerId, viewingUserId}`, a comment states "no cursor until a rank-aware pagination strategy for smart search is decided" (`:292`), and it requests `take: size` with no offset, so `nextCursor` is always null.

### 1.3 Text embedding (ML service call)

- `S/repositories/machine-learning.repository.ts:211-215`: POST `{ml url}/predict` as multipart form with `entries` = `{"clip": {"textual": {"modelName": <clip.modelName>, "options": {"language": <language>}}}}` and field `text` (`:228-242`, `:162-183`). Immich keys: `ModelTask.SEARCH` is `clip`, `ModelType.TEXTUAL` is `textual`.
- The reply is `{"clip": "<JSON array string>"}`. The embedding stays a string and is passed to SQL as a pgvector literal (`immich/machine-learning/immich_ml/models/clip/textual.py:39`, `transforms.py:71-72`).
- Language handling lives in the ML server. Only NLLB-based multilingual models (`modelName` starting `nllb`) use it: the Weblate code maps to a FLORES-200 code, tried first with the full code, then without the country part, then falling back to `eng_Latn`, and the code is prefixed to the text (`textual.py:118-128`, `is_nllb` at `:49`). Other models ignore `language`. Text is first normalised by `clean_text` (`:119`).
- Multiple ML URLs are tried healthy-first (`S/repositories/machine-learning.repository.ts:162-183`). A failure on all URLs throws, which surfaces as a 500 to the client.
- Image side: `encodeImage(path, clip)` posts `{clip: {visual: {modelName}}}` with the image file (`:205-209`).

### 1.4 The vector query

Table `smart_search(assetId uuid PK FK asset ON DELETE CASCADE, embedding vector(512))` with an HNSW cosine index `clip_index` (`ef_construction 300, m 16`), created `synchronize: false` because the dimension changes with the model (`S/schema/tables/smart-search.table.ts:5-16`). The column dimension is whatever the active model needs (section 2.3).

Flat query (`S/repositories/search.repository.ts:320-338`):

```
BEGIN; SET LOCAL vchordrq.probes = <n>;
SELECT <searchAsset columns> FROM asset
  [joins and where from searchAssetBuilderLegacy]
  INNER JOIN smart_search ON asset.id = smart_search.assetId
  ORDER BY smart_search.embedding <=> :embedding, asset.id ASC
  LIMIT size + 1 OFFSET (page - 1) * size;
```

`<=>` is cosine distance (0 identical, 2 opposite). There is no distance cutoff: every embedded asset ranks, so results always fill the page. `size + 1` rows are fetched to compute `hasNextPage` (`paginationHelper`). `size` is validated to 1..1000 (`:321-323`).

Filter semantics in the flat builder (`S/utils/database.ts:426-545`):

- Owner: `asset.ownerId = ANY(userIds)` (`:489`), where `userIds` is the caller plus partners.
- Visibility: `'not-locked'` becomes `visibility != 'locked'`; an explicit value becomes equality (`:432-436`). Hidden assets carry no embedding (the encode job skips them, `S/services/smart-info.service.ts:99-101`), so they do not appear.
- Trashed: `asset.deletedAt IS NULL` unless `withDeleted`, which is also switched on by `trashedAfter`, `trashedBefore` or `isOffline` (`:427`, `:545`).
- `isNotInAlbum`, `albumIds`, `personIds`, `tagIds`, `rating`, exif fields, dates, `type`, `isFavorite`, `ocr` as in metadata search.
- Locked assets are never included for partners (`:356-367`).

Structured builder (`:795-835`): ownership applies globally unless branches are album-confined; locked assets are visible only to `lockedOwnerId` (`:814-816`). Trashed assets are not excluded by default there; `trashedAt` is an ordinary filter (`:776`). Our `filterCriteria` adds `deleted_at IS NULL` when `trashedAt` is absent (`src/search/criteria.ts:321`), which differs from Immich but is the safer behaviour for the clients that exist today.

### 1.5 Pagination contract and client behaviour

- Web (`immich/web/src/routes/(user)/search/[[photos=photos]]/[[assetId=id]]/+page.svelte:121-160`): calls `searchSmart` with `{visibility: 'timeline', page: nextPage, withExif: true, query | queryAssetId, language: $lang, ...filters}`. It reads `assets.nextPage` through `Number(...) || 0` and stops when that is 0. It sends the smart request only when `featureFlagsManager.value.smartSearch` is true; otherwise it falls back to metadata search (`:142-148`, `:65`). The "similar photos" action navigates to a search with `queryAssetId` (`web/src/lib/services/asset.service.ts:333-334`), shown only when smart search is on and the asset is not locked, archived or trashed.
- Mobile (`immich/mobile/lib/infrastructure/repositories/search_api.repository.dart:20-50`): sends `SmartSearchDto(query, queryAssetId, language, country, state, city, make, model, takenAfter/Before, visibility (archive or timeline), rating, isFavorite, isNotInAlbum, personIds, tagIds, type, page, size: 100)`. It continues while `nextPage != null` (`mobile/lib/presentation/pages/search/search.page.dart:779`). It enables the UI from `ServerFeatures.smartSearch` (`mobile/lib/models/server_info/server_features.model.dart:15,24`).
- Neither client sends `filter` or `cursor` today. Both need `nextPage` to be a decimal string for the next page.

### 1.6 Feature flag and config

- `GET /server/features` returns `smartSearch: isSmartSearchEnabled(config.machineLearning)` and `duplicateDetection: isDuplicateDetectionEnabled(...)` (`S/services/server.service.ts:94,96`; `isDuplicateDetectionEnabled` is smart search enabled and `duplicateDetection.enabled`, `S/utils/misc.ts:103-104`). Ours hardcodes both false (`src/server/routes.ts:23-26`).
- Config (`S/dtos/config.dto.ts:207-240`, defaults `:619-634`): `machineLearning.enabled` (default true, env `IMMICH_MACHINE_LEARNING_ENABLED`), `urls[]`, `availabilityChecks`, `clip {enabled: true, modelName: 'ViT-B-32__openai'}`, `duplicateDetection {enabled: true, maxDistance: 0.01}` with the schema bound `0.001..0.1` (`:220-225`), `facialRecognition {enabled, modelName 'buffalo_l', minScore 0.7, maxDistance 0.5, minFaces 3}`. Model names are validated against `CLIP_MODEL_INFO`, which maps each name to its dimension (`S/constants.ts:67-` ; dims in the table are 512 (12 models), 640 (4), 768 (18), 1024 (14), 1152 (8), 1536 (2)) through `getCLIPModelInfo` (`S/utils/misc.ts:156-163`). The validator throws "Unknown CLIP model" on a bad name (`S/services/smart-info.service.ts:23-32`).
- Our `getSystemConfig` already returns `machineLearning.facialRecognition.minFaces` (`src/server/routes.ts:38`); the `clip` and `duplicateDetection` keys must be present in the stored config and the admin PUT/GET `/system-config` shape. EmbeddingGemma 2 is not in Immich's `CLIP_MODEL_INFO`, so the web admin dropdown (`MachineLearningSettings.svelte`) shows a free-text or fixed model name; report a stable `modelName` such as `embeddinggemma2` and do not validate against Immich's table.

### 1.7 Suggestions and explore

`GET /search/suggestions` and `GET /search/explore` do not use embeddings. Suggestions read distinct exif values for the caller plus partners (`S/services/search.service.ts:206-239`); explore returns recent assets and top cities (`:48-72`). Both exist in our code already (`src/search/routes.ts:140-214`). Smart search interacts with them only through the web filter panel, which feeds `country`, `state`, `city`, `make`, `model` into the smart request; those are plain SQL filters on the asset join.

### 1.8 Our current state

`POST /search/smart` reads the body and returns an empty Immich-shaped result (`src/search/routes.ts:218-224`). The file header documents that partner scope is not implemented (`:1-8`). `smartSearch` and `duplicateDetection` features are false (`src/server/routes.ts:23-26`). `smartSearch` and `duplicateDetection` queues are accepted and do nothing (`src/jobs/routes.ts:21-24`). There is no `ml` Container, no Vectorize binding and no embedding table (`wrangler.jsonc`: only `MediaContainer`, D1, R2, queues).

## 2. The smart-search job

### 2.1 When embeddings are computed

- After thumbnails on upload: when `AssetGenerateThumbnails` finishes and `item.data.source === 'upload'` or `notify` is set, the job service queues `SmartSearch`, `AssetDetectFaces` and `Ocr` for the asset (`S/services/job.service.ts:166-182`). Videos also queue encode.
- Duplicate detection chains from smart search: when a `SmartSearch` job completes with `source === 'upload'`, the job service queues `AssetDetectDuplicates` (`:251-256`).
- Admin queue "Start" queues `SmartSearchQueueAll` with `force` (`S/services/queue.service.ts:212-213`). `handleQueueEncodeClip` (`S/services/smart-info.service.ts:67-85`) streams asset ids in batches and queues one `SmartSearch` job per asset. Without `force` it selects only assets that have no `smart_search` row (`S/repositories/asset-job.repository.ts:213-220`); with `force` it first calls `setDimensionSize(dimSize)` (which deletes every embedding, `:74-78`) and then queues all assets. Default concurrency is 2 (`S/dtos/config.dto.ts:603`).
- Candidate set (`assetsWithPreviews`, `asset-job.repository.ts:180-194`): not hidden, `deletedAt IS NULL`, has an `asset_job_status` row, and has a preview file.

### 2.2 What is embedded

`handleEncodeClip` (`smart-info.service.ts:87-119`):

1. Skip when smart search is disabled.
2. `getForClipEncoding(id)` returns the asset id, visibility and its preview file (`asset-job.repository.ts:222-230`). Fail unless exactly one preview file exists (`:95-97`); skip hidden assets (`:99-101`).
3. Encode the preview image (a downscaled JPEG; the original is never sent) via `encodeImage` (`:103`).
4. If a dimension change is in progress, wait for the DB lock (`:105-108`).
5. Re-read config; if the model name changed while encoding, skip (`:110-114`).
6. `searchRepository.upsert(assetId, embedding)` (`S/repositories/search.repository.ts:480-486`).

Ours: the preview is `thumbKey(id, 'preview')` in R2 (`src/process/thumbs.ts`, listed in `assetObjectKeys`, `src/cron/purge.ts:16-18`). The Container can read it through the existing outbound-handler pattern (`src/container/outbound.ts`) with no new credentials.

### 2.3 Dimension and re-embedding

- `smart_search.embedding` has a fixed dimension, enforced by a `dim_size_constraint` check and the column type (`S/repositories/database.repository.ts:322-357`). `getDimensionSize` reads `atttypmod` and assumes 512 if unreadable (`:297-320`).
- On startup and on config update (`smart-info.service.ts:34-65`): if the model name changed and the dimension is the same, `deleteAllSearchEmbeddings()` truncates the table (`database.repository.ts:359-361`); if the dimension differs, `setDimensionSize` deletes rows, rewrites the constraint and column type, and rebuilds the index. In both cases the code carries a TODO: nothing re-queues the library ("A job to reindex all assets should be scheduled, though user confirmation should probably be requested", `:62-63`). The admin must press Start on the Smart Search queue.
- In-flight jobs that finish after a model change are discarded (`:110-114`).

### 2.4 Recommended shape here

- Add D1 `asset_embeddings(asset_id TEXT PRIMARY KEY, model TEXT NOT NULL, dim INTEGER NOT NULL, embedding BLOB NOT NULL, created_at TEXT NOT NULL)` as the source of truth for vectors (float32 little-endian; 768 dims is 3 KiB per row, 100k rows is about 300 MB, inside D1's 10 GB database limit; UNVERIFIED against current D1 limits page, check before building). Vectorize is a derived index that can be rebuilt from this table. A model change deletes the rows whose `model` differs and clears the Vectorize index.
- Add `asset_job_status(asset_id, smart_search_at, duplicates_detected_at)` or two nullable columns on `assets`, so the Start button can select pending work as Immich does (`asset-job.repository.ts:196-220`).
- Add a `smartSearch` queue message type to the existing process queue consumer or a new `asset-embed` queue. Chain from `markReady` (`src/process/consumer.ts`, after `emitUploadReady` and `enqueueBackup`) for new uploads, skipping hidden assets.
- Embedding runs in the `ml` Container (a new class beside `MediaContainer`). The Worker receives the vector from the Container, writes `asset_embeddings` and upserts Vectorize. Containers cannot call Vectorize directly (bindings reach containers only through outbound handlers, `docs/research/2026-10-13-phase3-platform.md`, section "Bindings and outbound network"), so the Worker upserts.
- Purge: add the Vectorize ids to the purge path next to `assetObjectKeys` (`src/cron/purge.ts:16-38`), through `deleteByIds` in batches, and delete the D1 row with the asset. Trashed assets keep their vector until purge, matching Immich (the table cascades on hard delete only).

## 3. Duplicate detection

### 3.1 The job

`S/services/duplicate.service.ts:318-374` (`handleSearchDuplicates`):

1. Skip when duplicate detection (or smart search) is disabled (`:321-323`).
2. Load the asset, its owner, type, `duplicateId`, `stackId`, visibility and embedding (`asset-job.repository.ts:30-38`). Fail if missing.
3. Skip stacked assets (`:331-334`), hidden assets (`:336-339`) and locked assets (`:341-344`). Fail if there is no embedding (`:346-349`).
4. Search neighbours (`S/repositories/duplicate.repository.ts:193-220`):

```
SET LOCAL vchordrq.probes = <n>;
WITH cte AS (
  SELECT asset.id AS assetId, asset.duplicateId,
         smart_search.embedding <=> :embedding AS distance
  FROM asset
  JOIN smart_search ON asset.id = smart_search.assetId
  WHERE asset.visibility IN ('archive', 'timeline')   -- withDefaultVisibility, S/utils/database.ts:110-112
    AND asset.ownerId = ANY(:userIds)                  -- [asset.ownerId] only (:356)
    AND asset.deletedAt IS NULL
    AND asset.type = :type                             -- images match images, videos match videos
    AND asset.id != :assetId
    AND asset.stackId IS NULL
  ORDER BY distance LIMIT 64                           -- DUPLICATE_SEARCH_LIMIT, :15
)
SELECT * FROM cte WHERE distance <= :maxDistance;
```

   `maxDistance` is `config.duplicateDetection.maxDistance` (default 0.01, range 0.001..0.1). Same owner only: partner assets are never compared.
5. If matches exist, `updateDuplicates` (`:376-400`):
   - Collect the distinct non-null `duplicateId`s among matches.
   - Target group id: the asset's own `duplicateId`, else the first matched group id, else a new UUID (`:388`).
   - Assets to update: every match whose `duplicateId` differs from the target, plus the asset itself.
   - `merge({targetId, assetIds, sourceIds})` sets `duplicateId = target` on rows whose `duplicateId` is in the remaining source ids or whose id is in `assetIds` (`duplicate.repository.ts:225-233`). That merges two existing groups into one.
6. If no matches and the asset has a `duplicateId`, clear it (`:365-368`).
7. Record `duplicatesDetectedAt` on every touched asset (`:370-371`). The queue "Start" selects assets with an embedding, default visibility and no trash date, and `duplicatesDetectedAt IS NULL`, or all with `force` (`asset-job.repository.ts:196-210`; `handleQueueSearchDuplicates`, `duplicate.service.ts:302-316`).

Groups are not transitive by distance. A is within threshold of B and B of C, so A, B and C end up in one group even when A and C are farther apart than the threshold. Singletons are cleaned lazily on read (below).

### 3.2 `GET /duplicates`

`S/controllers/duplicate.controller.ts:17-26`, permission `duplicate.read`. Returns `DuplicateResponseDto[]` (`S/dtos/duplicate.dto.ts:5-11`): `{ duplicateId: uuid, assets: AssetResponseDto[], suggestedKeepAssetIds: uuid[] }`.

Service (`duplicate.service.ts:68-81`): first `cleanupSingletonGroups(userId)` nulls `duplicateId` on assets that are alone in their group (`duplicate.repository.ts:91-112`); then `getAll` (`:35-89`) selects the caller's assets with a non-null `duplicateId`, default visibility, `deletedAt IS NULL`, `stackId IS NULL`; each asset is joined with its full `asset_exif` row and tags; groups are aggregated with assets ordered by `localDateTime` ascending; groups of one are dropped in SQL (`json_array_length > 1`). Assets are mapped with `mapAsset` (so `exifInfo`, `tags` present, `duplicateId` set).

`suggestedKeepAssetIds` (`S/utils/duplicate.ts:25-60`): sort by `exifInfo.fileSizeInByte`, keep those with the largest size, tie-break by count of truthy `exifInfo` values, return one id (empty array for an empty list). It mirrors `web/src/lib/utils/duplicate-utils.ts`.

Ours returns `[]` (`src/assets/routes.ts:33`); `docs/api-coverage.md:138-143` marks the other three duplicate endpoints unchecked.

### 3.3 `DELETE /duplicates` and `DELETE /duplicates/{id}`

- `DELETE /duplicates` body `BulkIdsDto {ids: uuid[]}`, 204: `requireAccess(DuplicateDelete, ids)` then `UPDATE asset SET duplicateId = NULL WHERE ownerId = :user AND duplicateId IN (:ids)` (`duplicate.service.ts:88-91`; `duplicate.repository.ts:167-180`, chunked).
- `DELETE /duplicates/{id}` 204: same for one id (`:83-86`, `:157-165`). Both mean "keep all, dismiss the group". They do not touch the assets otherwise.
- Access check `checkOwnerAccess` (`S/repositories/access.repository.ts:330-344`): the id is accessible when the caller owns at least one non-trashed asset with that `duplicateId`.

### 3.4 `POST /duplicates/resolve`

Added in v3.0.0 as alpha (`duplicate.controller.ts:52-62`). Body `DuplicateResolveDto {groups: [{duplicateId, keepAssetIds[], trashAssetIds[]}]}` with at least one group (`duplicate.dto.ts:13-25`). Returns `BulkIdResponseDto[]` per group `{id: duplicateId, success, error?, errorMessage?}`. HTTP 200. Permission `duplicate.delete`.

`resolveGroup` (`duplicate.service.ts:112-237`), per group, errors are caught and reported as `UNKNOWN` (`:100-107`):

1. Load the group via `duplicateRepository.get` (non-trashed, unstacked assets with that id, with exif and tags); `NOT_FOUND` if missing (`:115-118`).
2. Ignore ids not in the group. Fail `VALIDATION` if an asset is in both lists, or if any group asset is in neither list (`:123-144`).
3. If any asset is to be trashed, require `asset.delete` on all of them, else `NO_PERMISSION` (`:146-156`).
4. When exactly one asset is kept and at least one is trashed, merge metadata onto the keeper (`:158-214`; `getSyncMergeResult`, `:239-300`):
   - `isFavorite`: true if any group asset is a favourite.
   - `visibility`: the first present of locked, archive, timeline across the group; hidden only if nothing else applies.
   - `rating`: the maximum rating, applied when greater than 0.
   - `description`: unique non-empty trimmed lines from all descriptions, joined with newlines.
   - `latitude`/`longitude`: copied only when exactly one distinct finite coordinate exists across the group, and both are present.
   - Albums: every album that contains any group asset (`albumRepository.getByAssetIds(userId, ids)`); the keeper is added to those the caller may add to (`album.asset.create`) when the caller may share the keeper (`asset.share`) (`:167-185`).
   - Tags: union of tag ids, filtered by `tag.asset` permission; the keeper's tags are replaced by the union, and the exif `tags` array is updated (`:187-201`).
   - If exif or tags changed, queue `SidecarWrite` for the keeper (`:210-212`).
   - Finally `UPDATE asset SET duplicateId = NULL, isFavorite, visibility` on the keeper (`:214`).
5. With several keepers, or no trash list, the kept assets only get `duplicateId = NULL` (`:215-217`).
6. Trashed assets: `deletedAt = now`, `status = trashed` (or `deleted` when `trash.enabled` is false), `duplicateId = NULL`, then emit `AssetTrashAll` or `AssetDeleteAll` (`:219-234`).

Not synced: `description` goes to exif only; `ocr`, faces, stacks and `livePhotoVideoId` are untouched.

Mapping to our code: use the existing helpers for albums (`insertAlbumAsset`, `bumpAlbum`, `allowedAlbumIds` in `src/albums/repo.ts:76-241`), asset access (`shareableAssetIds`, `src/access/assets.ts:37`), trash and the `changes` writer (`src/db/changes.ts`, `tracked`/`commit`) so that every change to `deleted_at`, `is_favorite`, `visibility` and exif bumps the sync cursor. A sidecar job has no equivalent here (`sidecar: false`); skip it.

### 3.5 Web flow

`immich/web/src/routes/(user)/utilities/duplicates/[[photos=photos]]/[[assetId=id]]/`:

- `+page.ts:6-12` loads `getAssetDuplicates()` once.
- Single group: user picks assets to trash in the compare control; `resolveDuplicates({groups: [{duplicateId, keepAssetIds: group minus trash, trashAssetIds}]})` (`+page.svelte:99-125`); the group is removed from the local list.
- "Deduplicate all": for every group, keep `suggestedKeepAssetIds`, trash the rest, one `resolveDuplicates` call (`:136-175`).
- "Keep all" calls `deleteDuplicates({bulkIdsDto: {ids}})` (`:186-196`).
- "Stack" calls `createStack({assetIds})` and removes the group (`:128-134`).
- Mobile has no duplicates screen (no matches in `mobile/lib` outside the generated API).

### 3.6 Sync impact

`SyncAssetV2` has no `duplicateId` (`S/dtos/sync.dto.ts:89-112`; `dtos/sync.dto.ts` has no "duplicate" string). The API field `AssetResponseDto.duplicateId` exists (`S/dtos/asset-response.dto.ts:106,240`) and `PUT /assets/{id}` accepts it (`S/services/asset.service.ts:149-155`; ours validates it at `src/assets/update.ts:70`). Consequence for us: add `assets.duplicate_id TEXT` plus an index on `(owner_id, duplicate_id)`, map it in `mapAssetResponse`, and write it with plain `UPDATE` statements that do not set `update_id`. No mobile resync is triggered. The resolve path changes synced columns of kept and trashed assets, so those writes use `tracked(...)`.

## 4. Cloudflare Vectorize fit

Docs consulted (all fetched 2026-10-13):

- Limits: https://developers.cloudflare.com/vectorize/platform/limits/ (last updated Aug 5, 2026)
- Pricing: https://developers.cloudflare.com/vectorize/platform/pricing/
- Metadata filtering: https://developers.cloudflare.com/vectorize/reference/metadata-filtering/
- Query best practices: https://developers.cloudflare.com/vectorize/best-practices/query-vectors/
- Insert best practices: https://developers.cloudflare.com/vectorize/best-practices/insert-vectors/
- API reference: https://developers.cloudflare.com/vectorize/reference/client-api/
- Architecture post: https://blog.cloudflare.com/building-vectorize-a-distributed-vector-database-on-cloudflare-developer-platform/
- GA post with latency: https://blog.cloudflare.com/workers-ai-bigger-better-faster/

### 4.1 Limits (v2 indexes)

| Item | Limit |
|---|---|
| Dimensions per vector | 1536 max, float32 |
| Vectors per index | 20,000,000 |
| Indexes per account | 50,000 paid, 100 free |
| Namespaces per index | 50,000 paid, 1,000 free (the insert-vectors page still says 1,000; the limits page is newer) |
| Vector id | 64 bytes max (a UUID is 36) |
| Namespace name | 64 bytes max |
| Metadata per vector | 10 KiB |
| Metadata indexes per index | 10; each indexes the first 64 bytes of a string; numbers are float64 |
| topK | 100 without values or metadata; 50 with `returnValues: true` or `returnMetadata: 'all'`; `returnMetadata: 'indexed'` adds no latency |
| Upsert batch | 1,000 vectors from a Worker (5,000 over HTTP); 100 MB per upload |
| List vectors | 1,000 ids per page |
| Filter | non-empty object, compact JSON under 2,048 bytes; operators `$eq $ne $in $nin $lt $lte $gt $gte`; range operators only on strings and numbers; an upper and a lower bound may combine, other combinations are not allowed |

Dimension and metric are fixed at index creation. A new model with a different dimension needs a new index. `describe()` returns the configured dimensions and metric.

### 4.2 Pricing for the target workload

Formula from the pricing page: `((queried vectors + stored vectors) * dimensions * $0.01 / 1M) + (stored vectors * dimensions * $0.05 / 100M)`, with 50M queried dimensions and 10M stored dimensions included per month on Workers Paid. Workers Paid is already required for Containers.

Workload: 100,000 stored vectors, 5,000 queries per month (smart search plus upload-time duplicate lookups).

| Dimensions | Queried dims | Stored dims | Monthly charge beyond included |
|---|---|---|---|
| 512 | 53.8M | 51.2M | $0.04 + $0.02 = about $0.06 |
| 768 | 80.6M | 76.8M | $0.31 + $0.03 = about $0.34 |
| 1536 | 161.3M | 153.6M | $1.11 + $0.07 = about $1.18 |

Initial face clustering through Vectorize would add one query per face: about 150,000 faces at 512 dims is 76.8M queried dimensions, about $0.77 once, assuming the 50M allowance is already used. Vectorize cost is negligible against the $20 to $25 budget in the design. The cost driver for smart search is the Container (embedding every photo, and each uncached text query), not the index.

### 4.3 Latency

Cloudflare reports a median query latency of 30 ms for v2 indexes, measured through a Worker binding on warm caches at concurrency 300 (GA post, 2024). The architecture post attributes latency to fetching index fragments from R2 through caches; cold or rarely used indexes will be slower. No p95 or filtered-query numbers are published. UNVERIFIED for this workload; measure in the Phase 4 spike. The text-embedding Container call dominates end to end.

### 4.4 Upsert, delete and consistency

- `insert`, `upsert` and `deleteByIds` are asynchronous, return a mutation id, and "typically take a few seconds" to become queryable. Writes apply in arrival order; queries read an immutable snapshot (architecture post, "Eventual consistency and snapshot versioning").
- `upsert` replaces the whole vector including metadata; it does not merge. There is no metadata-only update, so changing a filterable property means re-sending the values. That is why section 2.4 keeps vectors in D1.
- `insert` ignores ids that already exist; use `upsert`.
- A metadata index only covers vectors written after the index exists. Create all indexes before the first upsert (`wrangler vectorize create-metadata-index <index> --property-name=<p> --type=<string|number|boolean>`).
- The returned `score` for a cosine index is a similarity (the doc example returns 0.9999 for a near-identical vector). Immich distance equals `1 - score`. Confirm the sign and range in the spike.
- Default scoring is approximate (the architecture post cites about 80% accuracy before a refinement pass and over 95% after). `returnValues: true` forces high-precision scoring with exact scores and costs latency and the lower topK of 50.
- `queryById(id, options)` queries with a stored vector and accepts the same options. Whether it honours `namespace` is not stated; fetch the vector from D1 and call `query` instead.

### 4.5 Filtering by owner and visibility

- Namespace: one namespace per owner id (36 bytes). The namespace filter is applied before vector search, so it improves recall and cost. A query searches one namespace. Partner-inclusive search (own plus partners in the timeline) means one query per namespace followed by a merge on score, with at most a few namespaces per user.
- Metadata indexes (10 available) worth creating: `type` (string: IMAGE or VIDEO, needed by duplicates), `visibility` (string), `trashed` (number 0 or 1), `taken_at` (number, epoch seconds), `is_favorite` (number). Low cardinality fields (`type`, `visibility`, `trashed`) are cheap to filter with `$eq` or `$in`; the insert-vectors page warns that range filters over high-cardinality values (millisecond timestamps) degrade, so bucket `taken_at` to days.
- Stale metadata: `visibility`, `trashed` and `is_favorite` change after upsert. Two options. (a) Re-upsert from D1 on each change through a queue (cheap, one vector per change, a few seconds of staleness). (b) Do not filter on mutable fields in Vectorize and post-filter in D1 with the same criteria builder already used for metadata search (`src/search/criteria.ts:97-361`), over-fetching. Recommended: (b) for everything except `type`, plus an authoritative D1 check in every case, because the D1 row is the only truth for access control. Vectorize results are candidate ids, and the Worker always joins `assets` with `owner_id IN (...)` and the visibility rule before returning anything.
- Locked assets: never upsert locked assets into the shared namespace path used for partner queries, or keep them in the D1 post-filter (`visibility != 'locked'` unless elevated and owner), as `applyLockedVisibilityPolicy` does (`S/utils/search-filter.ts`).

### 4.6 Smart search on Vectorize: fit and pagination

Fit is good for the query itself (cosine, one namespace per owner, 512 to 1536 dims, 100k vectors, median 30 ms).

Pagination is the gap. Immich pages with OFFSET over the full ranking; Vectorize caps each query at 100. Options:

| Option | Behaviour | Cost |
|---|---|---|
| A. Vectorize only, cap at rank 100 | Page 1 only at size 100; `nextPage` null after it. The web app stops scrolling, mobile stops | Simple. Visible regression for broad queries. Filtered searches are post-filtered, so fewer than 100 may survive |
| B. Vectorize with over-fetch plus several narrower queries | Re-query with date-bucket `taken_at` range filters to reach deeper ranks and concatenate in rank order | Complex; ranks across buckets are not comparable without a merge on score, which is possible but costs N queries per page |
| C. Exact scan | Hold the owner's vectors in memory (Durable Object or Container) and compute dot products | 100k x 512 int8 is 51 MB, 100k x 768 float16 is 154 MB (over the 128 MB DO memory limit, which is UNVERIFIED for current DO limits; check). Needs a warm instance |
| D. Hybrid | Vectorize for the first 100 ranks; fall back to C only when the client asks for page 2 or more | Two code paths |

Recommendation: A for the first release, with `size` clamped so the response carries up to 100 results and `nextPage: null` when the cap is reached; revisit with D if the cap is felt. For a 1-2 user library the quality of ranks beyond 100 for CLIP-style retrieval is low, and the structured shape already returns no cursor in Immich itself (`S/services/search.service.ts:292`). Implement the flat `page` parameter by over-fetching `page * size` up to 100 and slicing.

Query-time flow: Worker embeds the text via the `ml` Container (cache the last N embeddings in a Worker-global `Map`, as Immich does with a 100-entry LRU keyed by model, text and language, `S/services/search.service.ts:36,331`), calls `index.query(vec, {topK: 100, namespace: ownerId, filter: {type?}, returnMetadata: 'none'})` once per namespace, merges, joins D1 with the criteria builder, preserves Vectorize order, and maps with `mapAssetResponse`. For `queryAssetId`, check access (own, partner or album share through `canReadAsset`, `src/access/assets.ts:28`), load the vector from `asset_embeddings`, query, and drop the source asset id from the results only if Immich does (it does not; the source asset appears first). Keep it.

### 4.7 Duplicate detection and face clustering

Duplicates fit Vectorize:

- Per-asset query: namespace = owner, `filter: {type: <type>}`, `topK: 50`, `returnValues: true` (high-precision scores, needed because the threshold is tight: 0.01 distance means score at least 0.99), then drop the asset itself and any row failing the D1 post-filter (trashed, stacked, hidden, locked, owner mismatch), then keep matches with `1 - score <= maxDistance`. Immich's candidate limit is 64 (`duplicate.repository.ts:15`); 50 is the Vectorize ceiling with values. Groups larger than 49 near-identical photos (a long burst) will be truncated; the merge step still links them transitively through other members.
- Consistency: bursts uploaded within seconds may miss each other because neither vector is queryable when the other asset's job runs. Mitigations: queue the duplicate job with a delay of 60 s or more (Queues `delaySeconds`), and make the admin Start button (force off) a catch-up sweep over assets with `duplicates_detected_at IS NULL`. A force sweep recomputes everything.
- Threshold: Immich's default of 0.01 and the 0.001 to 0.1 range are calibrated for CLIP ViT-B-32 image embeddings. EmbeddingGemma 2 needs its own measurements: embed pairs of near-duplicates (burst frames, re-compressed copies) and unrelated photos, pick the default at the gap, and keep the config range. Because Vectorize cosine scores are approximate unless `returnValues` is set, calibrate with the same setting.
- Alternative with no Vectorize dependency for the sweep: for 100k vectors, a force sweep is 100k queries; through Vectorize that is about $0.77 at 512 dims (section 4.2) plus 100k subrequests, which is why batches go through queue consumers with a concurrency cap.

Faces do not fit Vectorize well:

- Immich's recognition (`immich/server/src/services/person.service.ts:582-620`) queries the nearest `minFaces` (3) faces within `maxDistance` 0.5 across all faces of the cluster group, with filters `deletedAt IS NULL`, optional `personGroupId IS NOT NULL` (the "has a person" check), and a birth-date exclusion (`S/repositories/search.repository.ts:356-401`). Faces are processed serially (queue concurrency 1), and each decision (create a person, assign to a person) must be visible to the next face's query.
- Vectorize writes appear after a few seconds, so consecutive faces of one person cannot see each other, which breaks the core-point rule (a new person needs `minFaces` matches).
- Filters on `has_person` need a re-upsert of the full vector at each assignment.
- Recommended: store face vectors in D1 or R2 (512 float32 = 2 KiB; 200k faces = 410 MB) and run recognition inside the `ml` Container as a batch: load all face vectors of the owner into memory (standard-4 has 12 GiB), brute-force exact cosine with a matrix-vector product (100k to 200k x 512 is tens of milliseconds per query), write assignments back through the Worker. This also removes the eventual-consistency problem. The Container is already planned for detection and embedding. Vectorize remains optional for a "search similar face" feature, which this project does not need.
- `docs/research/2026-10-13-face-models.md` covers the model choice; this section covers storage and search only.

### 4.8 Alternatives summary

| Need | Vectorize | D1 brute force | Vectors in R2 plus Container scan |
|---|---|---|---|
| Smart search, first 100 ranks | Fits, about $0.06 to $0.34 per month | 100k BLOB rows per query is too slow and heavy | Fits only with a warm Container |
| Smart search beyond rank 100 | Not possible (topK 100) | Same cost as above | Possible |
| Duplicate lookup per upload | Fits (topK 50 with values) | No | Possible in a batch |
| Duplicate force sweep | Works, about $0.77 per 100k | No | Better: one in-memory pass |
| Face clustering | Poor (consistency, mutable filters) | No | Best |
| Source of truth for vectors | No (cannot read back cheaply, no metadata-only update) | Yes: `asset_embeddings` and `face_embeddings` BLOB tables | Archive copy for rebuilds |

## 5. Implementation checklist for Phase 4 (search and duplicates)

1. Spike (already planned): EmbeddingGemma 2 image and text embeddings in the `ml` Container; output dimension (decides 512, 768 or more; Vectorize caps at 1536); L2 normalisation; text and image alignment quality on personal photos; cold start and warm latency; confirm Vectorize score range and `queryById` namespace behaviour; calibrate the duplicate threshold.
2. Migrations: `asset_embeddings`, `assets.duplicate_id` plus index, job status columns, `face_embeddings` later.
3. Config: add `machineLearning.clip {enabled, modelName}` and `duplicateDetection {enabled, maxDistance}` to the stored system config and its admin routes; set `smartSearch` and `duplicateDetection` in `/server/features` from the stored config and from whether an index is configured (`src/server/routes.ts:23-26`).
4. Ingestion: embed after `markReady`; idempotent upsert of D1 row and Vectorize vector; skip hidden assets; discard results whose model differs from the current config.
5. Admin queues: implement `smartSearch` and `duplicateDetection` `start` with the non-force and force semantics of section 2.1 and 3.1, using the existing start cap and cursor (`src/jobs/routes.ts:27`); drop them from `NOOP_START` (`:21-24`).
6. `POST /search/smart`: flat shape with `page`; accept structured `filter` with `nextCursor: null`; reuse `flatCriteria` and `filterCriteria`; return 400 `Smart search is not enabled` when off; partner scope remains the open gate C5 (`src/search/routes.ts:1-8`).
7. Duplicates: implement the four endpoints per section 3; the job per section 3.1 with a delayed queue message; no sync cursor bump for `duplicate_id` alone.
8. Purge: delete Vectorize ids and embedding rows with the asset (`src/cron/purge.ts`).
9. Tests: contract tests against the generated OpenAPI types for `SmartSearchDto`, `SearchResponseDto`, `DuplicateResponseDto`, `DuplicateResolveDto`; resolve semantics unit tests for each merge rule in section 3.4.
