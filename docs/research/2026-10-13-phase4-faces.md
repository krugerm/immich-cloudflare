# Phase 4 research: faces and people

Date: 2026-10-13. Source: Immich `3.3.0-rc.0` (`server/package.json`), read-only checkout. Paths below are relative to the Immich repo root unless they start with `src/`, `migrations/` or `docs/`, which are this repo. Model decision: buffalo_l with Immich defaults (`docs/research/2026-10-13-face-models.md`).

## 0. Findings that change the plan

1. Immich 3.3 no longer has a flat `person` table keyed by `id`. A person is a row keyed by `(ownerId, personGroupId)` inside a `person_group`, and person groups live in a `cluster_group` that one or more users share (`server/src/schema/tables/person.table.ts:39-85`, `person-group.table.ts:15-41`, `cluster-group.table.ts:12-29`). The API `id` of a person is the `personGroupId` (`server/src/dtos/person.dto.ts:291-306`).
2. Clustering runs per cluster group. Every new user gets a cluster group of their own (`server/src/services/base.service.ts:344-345`); users can join each other's group (`server/src/services/cluster-group.service.ts:60-67`), after which the same person group collects faces from all members' assets and each member has their own `person` row (name, hidden, favourite) for it. Our `src/users/map.ts:34` already reports `clusterGroupId = user id`, which matches the default.
3. People can be shared between users with roles `read`, `write`, `admin` (`person_user` table, `server/src/schema/tables/person-user.table.ts:21-62`, endpoints `/people/users` added in v3.3.0). A trigger creates a `person` row for the receiving user (`server/src/schema/functions.ts:222-243`).
4. The 3.3 mobile app requests `AssetFacesV3` from servers reporting 3.3.0 (`mobile/lib/domain/models/server_capability.model.dart:13`, `mobile/lib/infrastructure/repositories/sync_api.repository.dart:65-70`). We report 3.3.0 (`wrangler.jsonc` `SERVER_VERSION`), so V3 is the shape to build first. V3 is scoped to the cluster group and carries `deletedAt` and `isVisible`.
5. A forced re-cluster clears `personGroupId` on every machine-learning face, including faces a user reassigned by hand, then deletes people left without faces (`server/src/services/person.service.ts:523-526`, `server/src/repositories/person.repository.ts:288-300`, `person.service.ts:355-367`). Only `manual` and `exif` faces survive. The earlier face-models note says the person thumbnail crops the preview; in 3.3 it crops the original for images and the preview for videos (`server/src/services/media.service.ts:398-410`).

## 1. Pipeline

### 1.1 Triggers

| When | What is queued | Source |
|---|---|---|
| Upload, after thumbnails | `AssetDetectFaces {id}` (with `SmartSearch`, `Ocr`) once `AssetGenerateThumbnails` finishes for an upload | `server/src/services/job.service.ts:166-182` |
| Per-asset "refresh faces" (`POST /assets/jobs` name `refresh-faces`) | `AssetDetectFaces {id}` | `server/src/services/asset.service.ts:482-484` |
| Admin, Face Detection "start" | `AssetDetectFacesQueueAll {force}` | `server/src/services/queue.service.ts:232-234` |
| Admin, Facial Recognition "start" | `FacialRecognitionQueueAll {force}` | `server/src/services/queue.service.ts:236-238` |
| Detection found new faces | `FacialRecognitionQueueAll {force:false}` plus one `FacialRecognition {id}` per new face | `server/src/services/person.service.ts:466-469` |
| Nightly, `nightlyTasks.clusterNewFaces` | `FacialRecognitionQueueAll {force:false, nightly:true}` | `server/src/services/queue.service.ts:295-297` |
| Nightly cleanup | `PersonCleanup` | `server/src/services/queue.service.ts:275` |
| Cluster group "regenerate people" | `FacialRecognitionQueueAll {clusterGroupId, force:true}` | `server/src/services/cluster-group.service.ts:75-81` |

Queue settings: `faceDetection` concurrency 2 (`server/src/dtos/config.dto.ts:602`). `facialRecognition` is excluded from concurrent queues, so it runs one job at a time (`server/src/services/queue.service.ts:258-265`). `FacialRecognitionQueueAll` is deduplicated by job id (`server/src/repositories/job.repository.ts:271-272`).

Config defaults (`server/src/dtos/config.dto.ts:635-641`): `enabled true`, `modelName buffalo_l`, `minScore 0.7` (range 0.1 to 1), `maxDistance 0.5` (range 0.1 to 2), `minFaces 3` (min 1). `metadata.faces.import` defaults to `false` (`config.dto.ts:659-661`). Our `src/defaults/system-config.json:139-145` already carries the same values.

### 1.2 Face detection job (`AssetDetectFaces`)

`server/src/services/person.service.ts:395-477`.

1. Skip when facial recognition is disabled. Load the asset with all faces, including soft-deleted and invisible ones, and its preview file (`server/src/repositories/asset-job.repository.ts:233-252`; the edited preview wins when both exist). Fail when there is no preview. Skip `visibility = hidden` assets (the video half of a live photo).
2. Send the preview path to ML with `{modelName, minScore}` (`server/src/repositories/machine-learning.repository.ts:190-203`). ML returns `imageWidth`, `imageHeight` (the decoded preview's size) and a list of `{boundingBox, embedding, score}`.
3. Reconcile with existing faces. Scale each new box into the coordinate space of the first existing face (`imageWidth / faces[0].imageWidth`), then find an existing face with IoU above 0.5 (`person.service.ts:428-455`, IoU at `479-494`):
   - match is an ML face: keep it as is (its id is removed from the delete set; no new embedding);
   - match is a manual or EXIF face: store the new embedding for that face id;
   - no match: create a face `{id, assetId, imageWidth, imageHeight, boundingBoxX1..Y2}` in the preview's coordinates, plus its embedding.
   ML faces with no match are hard-deleted. Because soft-deleted faces are loaded, a face the user deleted is matched again by IoU and is not re-created.
4. Write all three changes in one statement (`server/src/repositories/person.repository.ts:886-908`): insert `asset_face`, delete removed ids, insert `face_search`.
5. If faces were added, queue `FacialRecognitionQueueAll {force:false}` followed by `FacialRecognition {id}` for each new face. Set `asset_job_status.facesRecognizedAt = now` in every case (`person.service.ts:474`).

Box storage: integer pixels `boundingBoxX1, Y1, X2, Y2` plus the `imageWidth`, `imageHeight` they refer to (`server/src/schema/tables/asset-face.table.ts`). Clients scale boxes by these dimensions, so any image size works as long as the pair is stored with the box. ML rounds boxes (`machine-learning/immich_ml/models/facial_recognition/detection.py:36`); boxes can extend past the image edge, which the thumbnail code clamps.

`AssetDetectFacesQueueAll` (`person.service.ts:369-393`): with `force=true`, delete every `machine-learning` face, run person cleanup, vacuum; then queue `AssetDetectFaces` for every non-hidden, non-deleted asset with a preview, newest first, limited to `facesRecognizedAt IS NULL` when `force=false` (`asset-job.repository.ts:180-194, 446-452`).

### 1.3 ML: detection, alignment, embedding

- Detection (`machine-learning/immich_ml/models/facial_recognition/detection.py:19-39`): letterbox the RGB image into a square canvas of `FACE_DETECTION_SIZE` (image at the top-left, black padding, scale = new/old long edge, `machine-learning/immich_ml/models/transforms.py:82-93`), normalise `(x - 127.5) / 128`, NCHW, run SCRFD. Decode three FPN levels with strides 8, 16, 32 and 2 anchors per cell (`_ops.py:20-50`), keep `score >= minScore`, divide boxes and landmarks by the scale, NMS with IoU 0.4 (`_ops.py:53-56`), round boxes. The size constant comes from the external `immich-model` package (`machine-learning/pyproject.toml:76`) and is not in this tree; insightface uses 640 for `det_10g`. Confirm against `immich-app/ml-models` before porting.
- Alignment (`_ops.py:59-73`): Umeyama similarity transform from the 5 landmarks to the ArcFace template, `warpAffine` to 112x112.
- Recognition (`recognition.py:34-72`): normalise `(x - 127.5) / 127.5`, NCHW, batch through ArcFace R50, output 512 floats per face. Immich does not L2-normalise; pgvector's cosine operator does not need it. The response carries `score` per face, which the server ignores.

### 1.4 Facial recognition (clustering) job

`FacialRecognition {id, deferred}`, `server/src/services/person.service.ts:554-646`. The face search is `server/src/repositories/search.repository.ts:356-400`.

1. Load the face with its asset's `ownerId`, `visibility`, `fileCreatedAt`, the owner's `clusterGroupId`, and its embedding (`person.repository.ts:570-588`). Fail if missing or without embedding. Skip if `sourceType` is not `machine-learning`. Skip if it already has a `personGroupId` (this is what protects manual assignments during an incremental run).
2. `matches = searchFaces({clusterGroupId, embedding, maxDistance, numResults: minFaces, minBirthDate: fileCreatedAt})`. The search takes the `numResults` nearest faces by cosine distance among faces on non-trashed assets owned by any user in the cluster group, excluding faces whose person has `birthDate > fileCreatedAt` (a photo taken before the person was born), then drops those with distance above `maxDistance`. It does not filter on `asset_face.deletedAt` or `isVisible`. The face itself is among the matches.
3. If `minFaces > 1` and `matches.length <= 1`, skip (only matched itself).
4. `isCore = matches.length >= minFaces && asset.visibility = 'timeline'`. A non-core face on the first pass is re-queued as `{id, deferred: true}` and skipped. Because the queue is FIFO with concurrency 1, deferred faces run after every face queued before them.
5. `personGroupId` = the first match (nearest first) that has a `personGroupId`. If none, run a second search with `numResults: 1, hasPerson: true` and the same distance and birth-date filters, and take its group.
6. If still none and `isCore`, create a new `person_group` in the owner's cluster group (`person.repository.ts:774-782`).
7. If a group was found or created: create the owner's `person` row for that group if missing, with `faceAssetId = this face`, and queue `PersonGenerateThumbnail {ownerId, personGroupId}`. Assign the face to the group.

A deferred non-core face therefore joins the nearest existing person within `maxDistance`, and stays unassigned if there is none. It never founds a person. Hidden people are not considered anywhere in clustering: `isHidden` is a per-owner display flag, and hidden people keep receiving faces.

`FacialRecognitionQueueAll {force, nightly, clusterGroupId}` (`person.service.ts:496-552`):

1. Wait until the thumbnail and face detection queues are idle.
2. Nightly: skip if `system_metadata.FacialRecognitionState.lastRun` is later than `max(asset_job_status.facesRecognizedAt)` (`person.repository.ts:1005-1013`).
3. `force`: set `personGroupId = NULL` on all ML faces (optionally only those in one cluster group), run person cleanup, vacuum. Not forced and the facial recognition queue already has waiting jobs: skip.
4. Prewarm the vector index. Stream faces (not deleted, visible) that are, when forced, all faces (ML only when a cluster group is given), and otherwise ML faces with `personGroupId IS NULL` (`person.repository.ts:361-382`). Queue `FacialRecognition {id, deferred:false}` for each.
5. Store `lastRun` (the time captured before streaming).

On upload the detection job queues `QueueAll` first and then the per-face jobs. `QueueAll` waits for detection to drain, sees waiting jobs, and skips, so the per-face jobs do the work. The nightly run picks up faces that were left unassigned because they were not core at the time.

### 1.5 Manual faces, EXIF faces, edits

- `POST /faces` creates a `sourceType = manual` face on an asset for a named person, converting the client's preview-space box to original-image space when the asset has edits (`person.service.ts:761-834`). It has no embedding until a later detection run overlaps it (1.2 step 3). If the person had no feature face, a new one is picked.
- EXIF region faces (`metadata.faces.import`, off by default) become `sourceType = exif` faces with `imageWidth/Height = RegionInfo.AppliedToDimensions`; names map to existing people case-insensitively or create new groups and people (`server/src/services/metadata.service.ts:902-990`).
- Asset edits with a crop toggle `asset_face.isVisible` for faces outside the crop (`server/src/services/media.service.ts:825-848`, `person.repository.ts:1029-1060`). Invisible faces are excluded from people lists, counts, search and clustering input.

### 1.6 Person thumbnail

`PersonGenerateThumbnail {ownerId, personGroupId}` on the thumbnail queue, `server/src/services/media.service.ts:391-487`.

- Face: the person's `faceAssetId` (a face id despite the name). Input: the original for images (the embedded JPEG for RAW when `image.extractEmbedded`), the preview for videos.
- Crop (`getCrop`, `media.service.ts:455-487`): clamp the box to the stored `imageWidth/Height`, scale to the decoded input size, take the centre, half-size = `floor(max(halfWidth, halfHeight) * 1.1)` (10% margin), shrink so the square stays inside the image, crop a square.
- Output: 250 px (`FACE_THUMBNAIL_SIZE`, `server/src/constants.ts:65`), JPEG, quality `image.thumbnail.quality` (default 80, `config.dto.ts:696-700`), not progressive. Path `thumbs/<ownerId>/<personGroupId>.jpeg` (`server/src/cores/storage.core.ts:120-122`). Writing `thumbnailPath` bumps `updatedAt`, which the web uses as a cache key (`web/src/lib/utils.ts:257-258`).
- On completion the server sends websocket `on_person_thumbnail` with the person group id to the owner (`server/src/services/job.service.ts:126-129`); the people page listens for it (`web/src/routes/(user)/people/+page.svelte:65`).
- Feature face changes: a new person gets the face that created it; `PUT /people/{id}` with `featureFaceAssetId` (an asset id) picks that person's face on that asset; reassigning the feature face away or a person without one picks `getRandomFace` (first visible, non-deleted face of the group, `person.repository.ts:994-1003`) via `createNewFeaturePhoto` (`person.service.ts:174-192`). The thumbnail queue-all job also fills missing ones (`media.service.ts:90-106`).

### 1.7 Cleanup

`PersonCleanup` (`person.service.ts:355-367`): delete people whose group has no visible, non-deleted faces (`person.repository.ts:530-541`), unlink their thumbnails, delete person groups with no person rows, delete cluster groups with no users.

## 2. Data model

| Table | Columns and constraints | Source |
|---|---|---|
| `cluster_group` | `id` uuid PK, `name` nullable, `createdAt`, `updatedAt`, `updateId` | `server/src/schema/tables/cluster-group.table.ts` |
| `user.clusterGroupId` | FK to `cluster_group`, not null | `server/src/schema/tables/user.table.ts:88-89` |
| `person_group` | `id` PK, `clusterGroupId` FK cascade, `createdAt`, `createId`, `updatedAt`, `updateId`; after-delete trigger writes `person_group_audit` | `person-group.table.ts:15-41`, `functions.ts:259-270` |
| `person` | PK `(ownerId, personGroupId)`; `ownerId` FK user cascade; `personGroupId` FK `person_group` cascade; `name` default `''`; `thumbnailPath` default `''`; `isHidden` default false; `birthDate` date nullable, check `birthDate <= CURRENT_DATE`; `faceAssetId` FK `asset_face.id` on delete set null; `isFavorite` default false; `color` varchar nullable; `createdAt`, `updatedAt`, `updateId`. Trigram index on `f_unaccent(name)`. After-delete triggers write `person_audit` and delete `person_user` shares | `person.table.ts:19-85`, `functions.ts:209-220, 245-257` |
| `person_user` | PK `(personGroupId, sharedById, sharedWithId)`; FK `(sharedById, personGroupId)` to `person(ownerId, personGroupId)` cascade; `role` enum `read/write/admin`; check `sharedById != sharedWithId`; after-insert trigger upserts a `person` row for `sharedWithId` copying name and birthDate when empty | `person-user.table.ts:21-62`, `functions.ts:222-243` |
| `asset_face` | `id` PK; `assetId` FK asset cascade; `personGroupId` FK `person_group` on delete set null; `imageWidth`, `imageHeight`, `boundingBoxX1/Y1/X2/Y2` integers default 0; `sourceType` enum `machine-learning` (default), `exif`, `manual`; `deletedAt` (soft delete); `updatedAt`, `updateId`; `isVisible` default true. Indexes `(assetId, personGroupId)`, `(personGroupId, assetId)`, partial `(personGroupId, assetId) WHERE deletedAt IS NULL AND isVisible`. After-delete trigger (depth 0 only, so not on cascades from asset deletion) writes `asset_face_audit` | `asset-face.table.ts:20-89`, `functions.ts:298-309` |
| `face_search` | `faceId` PK, FK `asset_face` cascade; `embedding vector(512)`; HNSW cosine index `m=16, ef_construction=300` | `face-search.table.ts:4-17` |
| `person_audit` | `id` uuidv7, `personGroupId`, `ownerId`, `deletedAt` | `person-audit.table.ts` |
| `asset_face_audit` | `id` uuidv7, `assetFaceId`, `assetId`, `deletedAt` | `asset-face-audit.table.ts` |
| `asset_job_status.facesRecognizedAt` | set by detection; nightly skip uses its max | `person.service.ts:474`, `person.repository.ts:1005-1013` |
| `system_metadata` `FacialRecognitionState` | `{lastRun}` | `person.service.ts:549` |
| `user_metadata` preferences `people.minimumFaces` | per-user list threshold, default 3 when absent | `server/src/dtos/user-preferences.dto.ts:49`, `person.repository.ts:466-478` |

## 3. API

### 3.1 Endpoints

All require auth. API-key permission names are in parentheses. Person access (`server/src/utils/access.ts:55-90`, `server/src/repositories/access.repository.ts:521-571`): a `(ownerId, personGroupId)` pair is accessible when the caller owns it, or a `person_user` row shares it with the caller in an allowed role. Read accepts read/write/admin, update accepts write/admin, delete and merge accept admin only. Face access (`access.repository.ts:574-589`): the caller owns the face's non-trashed asset.

| Method and path | Request | Response | Behaviour | Source |
|---|---|---|---|---|
| `GET /people` (`person.read`) | `PersonSearchDto` query: `withHidden`, `closestPersonId`, `closestAssetId` (a face id), `page` (default 1), `size` (1 to 1000, default 500), `sharedById`, `sharedWithId`, `isFavorite`, `isHidden`, `name` | `PeopleResponseDto {people, total, hidden, hasNextPage}` | See 3.2 | `person.controller.ts:55-64`, `person.service.ts:62-98` |
| `POST /people` (`person.create`) | `PersonCreateDto {name?, birthDate? (date, not future, nullable), isHidden?, isFavorite?, color? (hex, nullable)}` | `PersonResponseDto` | New group in caller's cluster group plus person row | `person.service.ts:238-251` |
| `PUT /people` (`person.update`) | `PeopleUpdateDto {people: [{id, ...PersonUpdateDto}]}` | `BulkIdResponseDto[]` | Calls update per item; failures become `{success:false, error:'unknown'}` | `person.service.ts:310-331` |
| `DELETE /people` (`person.delete`) | `PeopleDeleteDto {ids, userId?}` | 204 | Deletes person rows for `ownerId = userId ?? caller`, unlinks thumbnails, deletes empty groups (faces then lose their group via set null) | `person.service.ts:333-353` |
| `GET /people/{id}` (`person.read`) | | `PersonResponseDto` | Caller's own person row for the group | `person.service.ts:194-203` |
| `PUT /people/{id}` (`person.update`); `PATCH` alias hidden | `PersonUpdateDto` = create fields plus `featureFaceAssetId?` (asset id) and `userId?`; at least one field besides `userId` | `PersonResponseDto` | `userId` targets another owner's row and allows only `name`, `birthDate`. Without `userId`, `name`/`birthDate` also propagate to owners who shared this person with the caller at write/admin. `featureFaceAssetId` resolves the person's face on that asset (400 if none or asset offline) and queues a thumbnail | `person.service.ts:253-304` |
| `DELETE /people/{id}` (`person.delete`) | `PersonDeleteDto {userId?}` body | 204 | Same as bulk delete | `person.service.ts:306-308` |
| `GET /people/{id}/statistics` (`person.statistics`) | | `{assets: int}` | Distinct timeline, non-trashed assets with a visible face of the group, owned by caller or partners or in a shared album of the caller | `person.repository.ts:716-739` |
| `GET /people/{id}/thumbnail` (`person.read`) | | JPEG, `Cache-Control` private without cache | Caller's thumbnail, else any thumbnail shared with the caller; 404 if none | `person.service.ts:219-236`, `person.repository.ts:659-686` |
| `PUT /people/{id}/reassign` (`person.reassign`) | `AssetFaceUpdateDto {data: [{personId, assetId, userId?}]}` | `PersonResponseDto[]` | For each item, the faces of person `personId` on `assetId` that the caller owns move to `{id}`; feature photos are re-picked where needed | `person.service.ts:100-142` |
| `POST /people/merge` (`person.merge`) | `MergePersonDto {ids}` (first is the target, at least 2, unique) | `BulkIdResponseDto[]` | See 3.3 | `person.controller.ts:192-203`, `person.service.ts:660-754` |
| `POST /people/{id}/merge` (deprecated) | `{ids}` | same | `mergePeople({ids: [id, ...ids]})` | `person.controller.ts:205-223` |
| `GET /people/users` (`person.read`) | `PersonUsersSearchDto {personId?, direction?, sharedById?, sharedWithId?, role?}` | `PersonUsersResponseDto` array of `{personId, sharedById, sharedWithId, sharedBy, sharedWith, role}` | v3.3.0 beta | `person.service.ts:842-846`, `server/src/repositories/person-user.repository.ts:19-60` |
| `PUT /people/users` (`person.update`) | `PeopleUsersUpsertDto {personIds? or type:'everyone', sharedWithIds, role}` | 204 | Targets must be in the caller's cluster group | `person.service.ts:848-892` |
| `DELETE /people/users` (`person.update`) | `[{personId, sharedWithId, sharedById?}]` | 204 | | `person.service.ts:894-901` |
| `GET /faces?id=<assetId>` (`face.read`) | `FaceDto {id}` | `AssetFaceResponseDto[]` | Requires asset read; visible, non-deleted faces ordered by `boundingBoxX1`, each with the caller's `person` row or null; boxes transformed for edits | `face.controller.ts:34-43`, `person.service.ts:165-172`, `person.repository.ts:543-556` |
| `POST /faces` (`face.create`) | `AssetFaceCreateDto {personId, assetId, userId?, imageWidth, imageHeight, x, y, width, height}` | 201, empty | Requires asset update and person read; see 1.5 | `person.service.ts:761-834` |
| `PUT /faces/{personId}` (`face.update`) | `FaceDto {id: faceId}` | `PersonResponseDto` | Moves one face (caller must own its asset) to the path person | `person.service.ts:144-163` |
| `DELETE /faces/{id}` (`face.delete`) | `AssetFaceDeleteDto {force}` | 204 | `force` hard-deletes (audit row), else sets `deletedAt` | `person.service.ts:836-840` |
| `GET /search/person` | `SearchPeopleDto {name, withHidden?}` | `PersonResponseDto[]` | Caller's people by trigram word similarity >= 0.5 on unaccented name, nearest first, limit 100 | `server/src/controllers/search.controller.ts:105-113`, `person.repository.ts:688-703` |
| `/cluster-groups/...` | requests, accept, leave, users, regenerate-people | | Joining a family cluster | `server/src/controllers/cluster-group.controller.ts:14-108` |

Route order: register `/people/users` and `/people/merge` before `/people/:id`.

DTO shapes (`server/src/dtos/person.dto.ts`):

- `PersonResponseDto` (109-138): `id` (person group id), `name`, `birthDate` (date string or null), `thumbnailPath`, `isHidden`, `updatedAt?`, `isFavorite?`, `color?`, `otherPeople: [{sharedById, name, birthDate, role}]`, `sharedBy: PeopleUserResponseDto[]`, `sharedWith: PeopleUserResponseDto[]` (user fields plus `role`). Without sharing the three arrays are empty.
- `AssetFaceResponseDto` (160-175): `id`, `imageWidth`, `imageHeight`, `boundingBoxX1/X2/Y1/Y2`, `sourceType?`, `person: PersonResponseDto | null`.
- `PeopleResponseDto` (274-289): `total`, `hidden`, `people`, `hasNextPage?`.
- `AssetResponseDto.people` (`server/src/dtos/asset-response.dto.ts:103, 165-178`): distinct people from the asset's faces, filled when the asset is loaded with faces.

### 3.2 `GET /people` semantics

Visible set (`server/src/repositories/person.repository.ts:442-481`): the caller's person rows whose group has a visible, non-deleted face on a non-trashed `timeline` asset owned by the caller or a partner, or in an album shared with the caller; kept when `name != ''` or the face count is at least the caller's `people.minimumFaces` preference (default 3). Hidden people are excluded unless `withHidden` or an explicit `isHidden` filter. `total` and `hidden` count the same set with filters (`person.repository.ts:740-755`).

Order (`person.repository.ts:486-528`): `isHidden` ascending, `isFavorite` descending, then either cosine distance between each person's feature-face embedding and the embedding of `closestAssetId` (or of `closestPersonId`'s feature face), or named first, face count descending, name ascending, `createdAt`. A `name` filter adds trigram similarity order. Pagination fetches `size + 1` rows to compute `hasNextPage`.

### 3.3 Merge semantics

`server/src/services/person.service.ts:660-754`: drop ids the caller cannot merge (admin role or owner). For each source and each owner who has a row in the source group: if that owner has no row in the target group, move their row and faces to the target group. Otherwise copy `name`/`birthDate` into the target when the target lacks them, move that owner's faces, delete the source row. Other owners are skipped when both rows have a name or both have a birth date. Empty groups are deleted afterwards.

### 3.4 Client usage

Web (`web/src`):

| Screen | Calls |
|---|---|
| People page `routes/(user)/people/+page.ts:23`, `+page.svelte` | `getAllPeople({withHidden:true, ...filters})`, `searchPerson`, `updatePerson` (hide, favourite, name), websocket `on_person_thumbnail` |
| Manage people `routes/(user)/people/manage/+page.ts:8`, `+page.svelte` | `getAllPeople({withHidden:true})`, `updatePeople` |
| Person page `routes/(user)/people/[personId]/.../+page.ts:10-11` | `getPerson`, `getPersonStatistics`, `updatePerson`, `searchPerson`, timeline with `personId`; merge (`MergeFaceSelector.svelte`: `getAllPeople`, `getPerson`, `mergePeople`) and unmerge (`UnmergeFaceSelector.svelte`: `getAllPeople`, `createPerson`, `reassignFaces`) |
| Explore `routes/(user)/explore/+page.ts:14` | `getAllPeople({withHidden:false})` |
| Asset viewer people panel `lib/components/faces-page/PersonSidePanel.svelte`, `lib/managers/AssetCacheManager.svelte.ts` | `getFaces({id: assetId})`, `reassignFacesById`, `createPerson`, `deleteFace` |
| Assign face `lib/components/faces-page/AssignFaceSidePanel.svelte:36` | `getAllPeople({withHidden:true, closestAssetId: faceId})` |
| Face editor / tag face `lib/components/asset-viewer/face-editor/FaceEditor.svelte:149`, `lib/modals/CreateFaceModal.svelte` | `getAllPeople({page, size:1000, withHidden:false})`, `createFace`, `createPerson` |
| Merge suggestion `lib/modals/PersonMergeSuggestionModal.svelte:38` | `mergePeople({ids:[target, source]})` |
| Search filters `lib/components/shared-components/search-bar/search-bar-utils.ts:143` | `getAllPeople({withHidden:false})`, then `personIds` in metadata/smart search |
| Sharing `lib/modals/PersonEditAccessModal.svelte`, `PersonBulkShareModal.svelte`, `lib/services/person-user.service.ts` | `getUsersForPeople`, `upsertPeopleUsers`, `removeUsersFromPeople`, `getAllPeople({withHidden:true, page, size:1000})` |
| Thumbnails everywhere | `GET /people/{id}/thumbnail?updatedAt=` (`lib/utils.ts:257-258`) |

Mobile (`mobile/lib`): people lists and the person timeline read the local database filled by sync (`data/db/main/dao/person.dart:26-63`: not hidden, asset not deleted, face visible and not deleted, at least `minFaces` faces or a name; ordered named first, then face count). REST use is limited to `PUT /people/{id}` for name and birthday (`data/server/person.dart`, `data/store/person.dart:56-62`), `GET /people/{id}/thumbnail` (`utils/image_url_builder.dart:24`) and `personIds` in search (`infrastructure/repositories/search_api.repository.dart:44, 75`).

### 3.5 Search and timeline by person

- `/search/metadata`, `/search/smart` flat field `personIds` (deprecated, `server/src/dtos/search.dto.ts:48`): asset must have visible, non-deleted faces of all listed groups (`server/src/utils/database.ts:274-288`).
- Filter tree `personIds: {any, all, none}` and `hasPeople` (`search.dto.ts:143-147, 275`; `database.ts:601-612, 748`).
- `GET /timeline/buckets|bucket?personId=` (`server/src/dtos/time-bucket.dto.ts:11`): `hasPeople` join, and assets in albums shared with the caller are included alongside owned ones (`server/src/repositories/asset.repository.ts:782-795`).

## 4. Sync

Request order excerpt from `SYNC_TYPES_ORDER` (`server/src/services/sync.service.ts:64-96`): `... MemoryToAssetsV1, MemoryToAssetsV2, PeopleV1, AssetFacesV1, AssetFacesV2, AssetFacesV3, UserMetadataV1, AssetMetadataV1, AssetEditsV1`.

| Request type | Passes (in order) | Scope | Source |
|---|---|---|---|
| `PeopleV1` | `PersonDeleteV1` from `person_audit` `{personId}`; `PersonV1` from `person` `{id (group id), createdAt, updatedAt, ownerId, name, birthDate, isHidden, isFavorite, color, faceAssetId}` | `ownerId = user` only | `sync.service.ts:915-927`, `server/src/repositories/sync.repository.ts:424-455` |
| `AssetFacesV1` | none; Immich returns 400 | | `sync.service.ts:929-933` |
| `AssetFacesV2` | `AssetFaceDeleteV1 {assetFaceId}`; `AssetFaceV2` with the V3 shape | faces on assets the user owns | `sync.service.ts:935-948`, `sync.repository.ts:466-500` |
| `AssetFacesV3` | `AssetFaceDeleteV1 {assetFaceId}`; `AssetFaceV3 {id, assetId, personId (group id, nullable), imageWidth, imageHeight, boundingBoxX1, boundingBoxY1, boundingBoxX2, boundingBoxY2, sourceType, deletedAt, isVisible}` | faces on assets owned by any user in the user's cluster group | `sync.service.ts:950-962`, `sync.repository.ts:477-513`, `server/src/dtos/sync.dto.ts:344-386, 527` |

Notes:

- Soft-deleted faces are upserts with `deletedAt` set; `AssetFaceDeleteV1` covers hard deletes only. The V3 delete query inner-joins `asset`, so deletes for purged assets are never sent, and the audit trigger does not fire on cascades. The mobile `asset_face` table has no foreign key to assets (`mobile/lib/data/db/main/table/people/asset_face.dart`), so those rows linger on the device.
- Partner and shared-album scoping does not apply to people. A user sees other users' people only through cluster groups (faces) and `person_user` shares (which create the user's own person row).
- The 3.3 app sends `peopleV1` and `assetFacesV3` (`mobile/lib/infrastructure/repositories/sync_api.repository.dart:65-70`) and handles `PersonV1`, `PersonDeleteV1`, `AssetFaceV1/V2/V3`, `AssetFaceDeleteV1` (`mobile/lib/domain/services/sync_stream.service.dart:322-331`).
- `PersonV1.birthDate` is typed date-time in the sync DTO; send `YYYY-MM-DD` or an ISO timestamp at midnight UTC as Immich serialises it.

## 5. This repo: what exists and where faces plug in

### 5.1 Existing

| Item | Location | State |
|---|---|---|
| `GET /people` | `src/assets/routes.ts:32` | stub, empty list |
| `GET /faces` | `src/assets/routes.ts:29` | stub, `[]` |
| `GET /search/person` | `src/search/routes.ts:226-229` | stub, `[]` |
| `personIds`, `hasPeople` in search | `src/search/criteria.ts:129-131, 288, 310-312` | match nothing |
| `personId` on timeline | `src/timeline/routes.ts:88` | matches nothing |
| `refresh-faces` asset job | `src/assets/manage-routes.ts:14, 82` | accepted, no-op |
| Admin queues `faceDetection`, `facialRecognition` | `src/jobs/routes.ts:14-25` | listed, no work |
| Sync request order | `src/sync/passes.ts:166-196` | no people or faces |
| Change cursors | `src/db/changes.ts` | one `Tracked` statement writes one synced row |
| Process pipeline | `src/process/consumer.ts` (`processAsset`, `markReady`, `markNeedsMedia`), queue `asset-process` | writes `thumbs/<id>/preview.jpeg` (short edge 1440, JPEG q80) and `thumbnail.webp` |
| Container | `src/container/contract.ts`, `client.ts` (`MEDIA_CONTAINER`, 3 instances, 120 s timeout) | video and large-image endpoints only |
| Daily cron | `src/cron/index.ts:44-74` (`17 3 * * *`) | no face steps |
| `clusterGroupId` | `src/users/map.ts:34` | equals user id |
| Config | `src/defaults/system-config.json:139-145, 163-165` | Immich face defaults present |

### 5.2 Proposed D1 schema (`migrations/0100_faces.sql`)

Start with one cluster group per user, stored as a column so a family group can be added later without reshaping tables. Defer `person_user` sharing and the cluster-group endpoints to a later step; return empty `otherPeople`, `sharedBy`, `sharedWith`.

```sql
ALTER TABLE users ADD COLUMN cluster_group_id TEXT;            -- backfill with id; new users get their own id
ALTER TABLE assets ADD COLUMN faces_recognized_at TEXT;

CREATE TABLE person_groups (
  id TEXT PRIMARY KEY,
  cluster_group_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX person_groups_cluster ON person_groups (cluster_group_id);

CREATE TABLE people (
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  person_group_id TEXT NOT NULL REFERENCES person_groups(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  birth_date TEXT,                  -- YYYY-MM-DD; API rejects future dates
  is_hidden INTEGER NOT NULL DEFAULT 0,
  is_favorite INTEGER NOT NULL DEFAULT 0,
  color TEXT,
  face_id TEXT,                     -- Immich faceAssetId (a face id)
  thumbnail_key TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  update_id TEXT NOT NULL,
  PRIMARY KEY (owner_id, person_group_id)
);
CREATE INDEX people_owner_update ON people (owner_id, update_id);
CREATE INDEX people_group ON people (person_group_id);
CREATE TABLE person_audit (id TEXT PRIMARY KEY, person_group_id TEXT NOT NULL, owner_id TEXT NOT NULL, deleted_at TEXT NOT NULL);

CREATE TABLE asset_faces (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,           -- asset owner, denormalised for access and sync
  cluster_group_id TEXT NOT NULL,   -- denormalised for AssetFaceV3 and clustering
  person_group_id TEXT,
  image_width INTEGER NOT NULL,
  image_height INTEGER NOT NULL,
  x1 INTEGER NOT NULL, y1 INTEGER NOT NULL, x2 INTEGER NOT NULL, y2 INTEGER NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'machine-learning' CHECK (source_type IN ('machine-learning', 'exif', 'manual')),
  is_visible INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  updated_at TEXT NOT NULL,
  update_id TEXT NOT NULL
);
CREATE INDEX asset_faces_asset ON asset_faces (asset_id);
CREATE INDEX asset_faces_group ON asset_faces (person_group_id, asset_id) WHERE deleted_at IS NULL AND is_visible = 1;
CREATE INDEX asset_faces_cluster_update ON asset_faces (cluster_group_id, update_id);
CREATE INDEX asset_faces_owner_update ON asset_faces (owner_id, update_id);
CREATE INDEX asset_faces_unassigned ON asset_faces (cluster_group_id, id)
  WHERE person_group_id IS NULL AND source_type = 'machine-learning' AND deleted_at IS NULL AND is_visible = 1;
CREATE TABLE asset_face_audit (
  id TEXT PRIMARY KEY, face_id TEXT NOT NULL, asset_id TEXT NOT NULL,
  owner_id TEXT NOT NULL, cluster_group_id TEXT NOT NULL, deleted_at TEXT NOT NULL
);

CREATE TABLE face_embeddings (
  face_id TEXT PRIMARY KEY REFERENCES asset_faces(id) ON DELETE CASCADE,
  embedding BLOB NOT NULL           -- 512 x float32 little-endian, 2048 bytes
);
```

Constraints that follow from our sync design:

- Every write that changes a synced `people` or `asset_faces` row must set `update_id` through `tracked()`. Foreign-key actions (`ON DELETE SET NULL`, cascades) change rows without a cursor, so unassign faces and write `asset_face_audit` rows explicitly before deleting a group or purging an asset. Storing `owner_id` and `cluster_group_id` in the audit row lets us send face deletes for purged assets, which Immich does not.
- Bulk changes (merge, reassign many faces, forced re-cluster, person delete) touch many face rows, and `tracked()` assumes one row per statement. Either loop in chunks or add a bulk form to `src/db/changes.ts` that assigns a run of cursors (for example `seq + row_number()`) in one statement.
- `people.update_id` must change when a thumbnail is written so `updatedAt` (the web cache key) changes.

### 5.3 Pipeline on Cloudflare

1. **Detection.** After `markReady` in `src/process/consumer.ts` (and after the container paths finish for videos and large images), send `{assetId}` to a new `face-detect` queue unless the asset is hidden. The consumer reads `thumbs/<id>/preview.jpeg` and calls a new container endpoint, for example `POST /faces {key, minScore}` returning `{imageWidth, imageHeight, faces: [{boundingBox: {x1,y1,x2,y2}, score, embedding: number[512]}]}`. Add it to `src/container/contract.ts` and run it in the `ml` container from the design spec (`docs/superpowers/specs/2026-10-12-immich-cloudflare-design.md:62`). The consumer runs the IoU reconciliation from 1.2, writes faces and embeddings to D1 in one `commit`, upserts vectors into Vectorize, deletes vectors of removed faces, sets `faces_recognized_at`, and hands new face ids to the clusterer. Our preview has the same 1440 short edge as Immich's default (`server/src/dtos/config.dto.ts:702-705`); confirm it is stored upright, since clients draw boxes over the oriented image.
2. **Clustering.** Immich relies on one-at-a-time execution and FIFO order for the deferred pass. Use a Durable Object per cluster group (`FaceClusterer`) that owns the run: pass 1 pages unassigned ML faces from D1 (`asset_faces_unassigned`), runs the 1.4 algorithm with `deferred = false`, records deferred ids in its storage, then runs pass 2 over them. Alarms continue the run across invocations. A queue with `max_concurrency: 1` would serialise jobs but gives no point at which pass 1 is known to be finished.
3. **Triggers.** Upload: detection consumer calls the DO with new face ids. Admin `faceDetection` start: enqueue assets with `faces_recognized_at IS NULL` (`force`: delete ML faces, their vectors and empty people first). Admin `facialRecognition` start: DO run, `force` unassigns ML faces first. Daily cron: person cleanup (1.7) and the nightly run, skipped when `max(faces_recognized_at)` is older than the last run kept in `server_state`. `refresh-faces`: enqueue detection for those assets.
4. **Person thumbnail.** Crop `preview.jpeg` with the Images binding (trim to the 1.6 square, resize to 250, JPEG q80) and store it at `people/<ownerId>/<personGroupId>.jpeg` in R2. Using the preview keeps the work in the Worker; faces smaller than about 250 px in the preview will be upscaled, where Immich crops the original. Then set `thumbnail_key`, bump `update_id`, and emit `on_person_thumbnail` through the realtime hub. Serve `GET /people/:id/thumbnail` from R2 with `Cache-Control: private, no-cache`.
5. **Read paths.** Implement `GET /people`, `/people/:id`, statistics, `/faces`, `/search/person` and the `personIds`/`hasPeople`/`personId` filters with D1 joins on `asset_faces_group`. Name search: Immich uses trigram similarity; D1 can approximate with case-insensitive `LIKE` and prefix-first ordering. `closestAssetId`/`closestPersonId`: load the target embedding and each candidate's feature-face embedding from `face_embeddings` and sort by cosine in the Worker (a page of 500 people reads about 1 MB).
6. **Sync.** Add `PeopleV1`, `AssetFacesV2` and `AssetFacesV3` to `REQUEST_ORDER` in `src/sync/passes.ts` between `MemoryToAssetsV2` and `AssetMetadataV1`, with delete passes first. V3 reads `asset_faces` by `(cluster_group_id, update_id)`; V2 by `(owner_id, update_id)`. Emit nothing for `AssetFacesV1` (our stream must not error).

### 5.4 Vectorize for nearest-neighbour search

Index: `faces`, 512 dimensions, metric `cosine`. Vector id = face id. Namespace = `cluster_group_id`, which limits the search to the cluster group before ranking; no metadata index is needed. Vectorize returns a cosine similarity score, so Immich's `distance = 1 - score` and `maxDistance 0.5` becomes `score >= 0.5`.

The Immich query cannot run as one Vectorize call because its filters depend on D1 state (asset trashed, person birth date, face has a person). Proposed mapping:

1. `query(embedding, {namespace, topK: K, returnMetadata: 'none'})` with K larger than `minFaces` (for example 10).
2. In D1, load the matched ids with `person_group_id`, the asset's `deleted_at`, and the person's `birth_date`; drop trashed assets and faces whose person was born after `fileCreatedAt`; keep `score >= 0.5`; take the first `minFaces` by score. Add the face itself if Vectorize did not return it, so the count matches Immich's "matches include the face itself" whether or not the new vector is indexed yet.
3. For the `hasPerson` fallback, query with the largest `topK` Vectorize allows without values or metadata (100, as I recall) and take the nearest D1-assigned match. Immich searches the whole cluster group for this; we miss an assigned face only when 100 nearer unassigned faces sit within distance 0.5, which should be rare.

Keeping the person assignment out of Vectorize metadata avoids re-upserting a vector on every reassignment and avoids reading stale assignments from an eventually consistent index. Vectorize applies writes asynchronously (mutation ids, `processedUpToMutation` in `describe()`), so a face inserted seconds earlier can be missing from results. The clusterer should wait until `describe()` reports the last detection batch's mutation before a run; the nightly run covers what is still missed.

Size for a family library (assumption: 4 users, 200k assets, about one detected face per asset):

| Item | Estimate |
|---|---|
| Vectors | 200k, 102M stored dimensions |
| D1 `asset_faces` | about 200 bytes per row, 40 MB |
| D1 `face_embeddings` | 2 KB per face, 400 MB (1 KB with float16) within D1's 10 GB database limit |
| Full re-cluster | up to 2 queries per face, 400k queries |
| Vectorize cost | from my recollection of the pricing ($0.05 per 100M stored dimensions, $0.01 per 1M queried dimensions counted as (queries + stored vectors) x dimensions), about $0.05 per month stored and about $3 per full re-cluster; incremental runs cost cents |

Limits to verify against current Cloudflare docs before building (from memory): 10M vectors per index, 1536 maximum dimensions, 50k namespaces per index, `topK` 100 without values or full metadata (20 otherwise), insert/upsert batches of 1000 from a Worker. All of these are well above a family library's needs.

Keeping embeddings in D1 lets us rebuild the Vectorize index, serve `closestAssetId` ordering, and move a user's vectors to another namespace when they join a family cluster group. Brute force without Vectorize does not fit: a per-group Durable Object would need about 400 MB of float32 (100 MB as int8) in memory against a 128 MB limit, and scanning D1 per query reads the whole table.

### 5.5 Decisions to confirm

1. Ship with one cluster group per user and no person sharing, adding the cluster-group and `/people/users` endpoints later.
2. Run detection and embedding in a separate `ml` container (Python onnxruntime with Immich's own code, or Node onnxruntime with a port of `_ops.py`).
3. Crop person thumbnails from the preview in the Worker instead of the original in a container.
4. Serialise clustering with one Durable Object per cluster group.
