# Phase 4 research: reverse geocoding and GPS time zones

Date: 2026-10-13. Immich source citations are relative to `server/` in the read-only checkout (`<immich-source-checkout>/server`). Project citations are relative to the repository root. Dataset sizes and lookup statistics below were measured on the GeoNames files downloaded on 2026-10-13.

## 1. Immich reverse geocoding

### Data sources and licences

| File | URL | Size (2026-10-13) | Licence |
|---|---|---|---|
| `cities500.zip` (unzips to `cities500.txt`, 236,112 rows, 41.6 MB) | https://download.geonames.org/export/dump/cities500.zip | 13.9 MB zip | GeoNames, CC BY 4.0 (attribution required) |
| `admin1CodesASCII.txt` (3,865 rows) | https://download.geonames.org/export/dump/admin1CodesASCII.txt | 152 KB | CC BY 4.0 |
| `admin2Codes.txt` (47,642 rows) | https://download.geonames.org/export/dump/admin2Codes.txt | 2.4 MB | CC BY 4.0 |
| `countryInfo.txt` (252 countries) | https://download.geonames.org/export/dump/countryInfo.txt | 32 KB | CC BY 4.0 |
| `ne_10m_admin_0_countries.geojson`, Natural Earth v5.1.2 | https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_admin_0_countries.geojson | 4.7 MB | Natural Earth, public domain |

Immich does not ship these in the repo. The image build downloads them: `ADD` lines in `immich-app/base-images`, `server/Dockerfile` (stage `geodata`), and writes `geodata-date.txt` with the build time. Paths are resolved in `src/repositories/config.repository.ts:336-343` (`dateFile`, `admin1`, `admin2`, `cities500`, `countryInfo`, `naturalEarthCountriesPath`). The file name constant is `citiesFile = 'cities500.txt'` (`src/constants.ts:57`).

### Tables

`geodata_places` (`src/schema/tables/geodata-places.table.ts`): `id` int PK (the GeoNames id), `name` varchar(200), `longitude`, `latitude` (double), `countryCode` char(2), `admin1Code` varchar(20) null, `admin2Code` varchar(80) null, `modificationDate` date, `admin1Name` null, `admin2Name` null, `alternateNames` null. Indexes: GiST on `ll_to_earth_public(latitude, longitude)` (`IDX_geodata_gist_earthcoord`), and trigram GIN indexes on `f_unaccent(name)`, `f_unaccent("admin1Name")`, `f_unaccent("admin2Name")`, `f_unaccent("alternateNames")`.

`naturalearth_countries`: `id` identity PK, `admin` varchar(50), `admin_a3` varchar(3), `type` varchar(50), `coordinates` Postgres `polygon` (`src/schema/tables/natural-earth-countries.table.ts`).

### Import

`MapRepository.init()` (`src/repositories/map.repository.ts:58-77`) reads `geodata-date.txt`. If it equals `SystemMetadataKey.ReverseGeocodingState.lastUpdate` (`src/enum.ts:375`, type `{ lastUpdate?, lastImportFileName? }` at `src/types.ts:559`) it returns. Otherwise it imports both datasets, then stores `{ lastUpdate: geodataDate, lastImportFileName: 'cities500.txt' }`. It runs at microservices start inside `MetadataService.init()` (`src/services/metadata.service.ts:161-175`): the metadata-extraction queue is paused, the import runs under advisory lock `DatabaseLock.GeodataImport = 100` (`src/enum.ts:1004`), then the queue resumes. A failed import throws and fails service init.

`importGeodata()` (`map.repository.ts:296-320`) loads admin1 and admin2 into maps keyed `<tab col0> -> <col1>`, builds `geodata_places_tmp`, swaps it in a transaction, then `loadCities500()` (`:322-396`) streams `cities500.txt`, batching 5,000 rows per insert. Column mapping (tab fields): id=0, name=1, alternateNames=3, latitude=4, longitude=5, featureCode=7 (filter only), countryCode=8, admin1Code=10, admin2Code=11, modificationDate=18. `admin1Name = admin1Map["CC.admin1"]`, `admin2Name = admin2Map["CC.admin1.admin2"]`. Rows are skipped when feature code is `PPLX` and country is not `AU`, or feature code is `PPLH` (`:340-343`). On the 2026-10-13 file this keeps 228,820 of 236,112 rows. Indexes are created after the load (`createGeodataIndices`, `:417-440`).

`importNaturalEarthCountries()` (`:258-294`) writes one row per polygon. For `MultiPolygon` it takes `entry[0]` (the outer ring only, holes dropped); for `Polygon` it takes the single ring and stops. Coordinates are `(lon,lat)` pairs.

### Lookup query

`MapRepository.reverseGeocode(point)` (`map.repository.ts:154-210`):

1. City: `earth_box(ll_to_earth_public(lat, lon), reverseGeocodeMaxDistance) @> ll_to_earth_public(latitude, longitude)`, ordered by `earth_distance(...)`, `limit 1`. `reverseGeocodeMaxDistance = 25_000` metres (`src/constants.ts:58`). Nearest place by great-circle distance within 25 km, regardless of population ranking.
2. On a hit: `city = place.name`, `state = place.admin1Name`, `country = countryNames.byAlpha2[place.countryCode]`. `admin2Name` is not used. Country names come from `countryInfo.txt` column 5 (`readCountryNames`, `:224-256`).
3. On a miss: log, then `naturalearth_countries WHERE coordinates @> point(lon, lat) LIMIT 1`. Result: `country = countryNames.byAlpha3[admin_a3]`, `state = null`, `city = null`. Natural Earth `ADM0_A3` does not always equal the ISO alpha-3 in `countryInfo.txt` (Kosovo is an example), in which case country is null.
4. No polygon match (open ocean): `{ country: null, state: null, city: null }`.

### Where it runs and what it writes

`handleMetadataExtraction` (`src/services/metadata.service.ts:229-`): `hasGeo(exifTags)` checks GPS (`:1073`); if `reverseGeocoding.enabled` (system config, default true; our `src/defaults/system-config.json:159`) it calls `reverseGeocode` (`:249-258`) and writes `asset_exif.country`, `state`, `city` in the exif upsert (`:260-275`). Without GPS, all three are null. The same method derives time zone and local time (section 2) and, in the same task list (`:370-395`), updates the asset row with `localDateTime`, `fileCreatedAt = dates.dateTimeOriginal`, `fileModifiedAt`, then upserts exif with `lockedPropertiesBehavior: 'skip'`.

### REST endpoints

`GET /map/reverse-geocode?lat&lon` (`src/controllers/map.controller.ts:31-41`, permission `MapSearch`). Query DTO (`src/dtos/map.dto.ts:5-10`): `lat` number in [-90, 90], `lon` number in [-180, 180]. `MapService.reverseGeocode` (`src/services/map.service.ts:21-27`) returns `[result]` as an array, where `result = { city: string|null, state: string|null, country: string|null }` (`MapReverseGeocodeResponseDto`, `map.dto.ts:12-18`). The result is always a one-element array, including the all-null case. Our stub returns `[]` (`src/map/routes.ts:38-48`).

`GET /search/places?name=` (`src/controllers/search.controller.ts:116-124`, `SearchService.searchPlaces` at `src/services/search.service.ts:43-46`). Repository `searchPlaces` (`src/repositories/search.repository.ts:403-428`): over `geodata_places`, matches with word-similarity `f_unaccent(col) %>> f_unaccent(name)` on any of `name`, `admin2Name`, `admin1Name`, `alternateNames`, ordered by the sum of `coalesce(f_unaccent(col) <->>> f_unaccent(name), 0.1)` across the four columns, `limit 20`. Response `PlacesResponseDto[]` (`src/dtos/search.dto.ts:94-102`, mapper `mapPlaces` at `:411-419`): `{ name, latitude, longitude, admin1name?, admin2name? }`; null admin names become absent keys. Our stub returns `[]` (`src/search/routes.ts:231-234`).

`GET /search/cities` (`search.controller.ts:127-137`, `searchRepository.getAssetsByCity`, `search.repository.ts:431-478`): one image per distinct `asset_exif.city` for the caller (and partners), timeline-visible, excluding trashed assets, `type = IMAGE`, ordered by city, returned as `AssetResponseDto[]` with `exifInfo`. Already implemented in our project (`src/search/routes.ts:178-195`); it reads only `asset_exif.city`, so it returns nothing useful until cities are filled in.

`GET /search/suggestions?type=country|state|city|...&country&state&includeNull` (`search.controller.ts:139-150`, `search.service.ts:206-245`, repository `getCountries`/`getStates`/`getCities` at `search.repository.ts:488-509`, shared `getExifField` at `:596-607`). `SELECT DISTINCT <field> FROM asset_exif JOIN asset` for the owner (and partner) ids, timeline visibility, excluding deleted assets, with the field neither null nor `''`. `state` filters by `country`; `city` filters by `country` and `state`. `includeNull` appends `null`. DTO `SearchSuggestionRequestDto` (`search.dto.ts:118-131`). The values come only from `asset_exif`; the places dataset is not queried. Our implementation exists (`src/search/routes.ts:140-176`) and works as soon as the columns are populated. Metadata search filters `city`, `state`, `country` are already mapped (`src/search/criteria.ts:157,186-188`), and indexes `asset_exif_owner_city` and `asset_exif_owner_place` exist (`migrations/0070_search_indexes.sql:4-5`).

## 2. Immich GPS time zone

Immich has no GPS-to-zone code in the services. It configures `exiftool-vendored` (`src/repositories/metadata.repository.ts:89-99`): `backfillTimezones: true`, `inferTimezoneFromDatestamps: true`, `inferTimezoneFromTimeStamp: true`, `defaultVideosToUTC: true`, `useMWG: true`, `geolocation: true`, and `geoTz: (lat, lon) => geotz.find(lat, lon)[0]` using the `geo-tz` package (`import geotz from 'geo-tz'` at `:3`, `"geo-tz": "^8.0.0"` in `package.json:82`; current npm version 8.1.10, MIT, 74.6 MB unpacked, depends on `pbf`, `geobuf`, `@turf/boolean-point-in-polygon`; its data derives from timezone-boundary-builder, ODbL). `useMWG` and `defaultVideosToUTC` stay as configured.

Zone resolution order inside exiftool-vendored's `ReadTask.ts` (`#extractTzOffset`, upstream main): explicit offset tags (`OffsetTimeOriginal`, etc.), then GPS (first `GeolocationTimeZone` from exiftool's own `-api geolocation` database, which Immich enables via `geolocation: true`, otherwise `geoTz(lat, lon)`), then datestamp inference, then `defaultVideosToUTC`, then UTC-offset and timestamp heuristics. `preferTimezoneInferenceFromGps` defaults to false, so a tag offset beats GPS. The result is `exifTags.zone`, an IANA name (for example `Europe/Zurich`) when it came from GPS, or a fixed-offset form (`UTC+2`) when it came from an offset.

`getDates` (`src/services/metadata.service.ts:1020-1070`): `timeZone = exifTags.zone ?? null`; if null and the raw value ends in `Z` or `+00:00`, `timeZone = 'UTC+0'`. A date without zone is first pinned to UTC with `keepLocalTime`, then `setZone(timeZone ?? 'UTC')` produces `dateTimeOriginal` (a true instant when a zone is known; otherwise the wall-clock time labelled UTC). `localDateTime = dateTimeOriginal.setZone('UTC', { keepLocalTime: true })`, that is the wall-clock time marked UTC. Without any EXIF date, both fall back to the earliest of `fileCreatedAt`, `mtime`, `birthtime` (`:1049-1062`).

Consequence for our backfill: for a photo with a wall-clock EXIF time and no offset, GPS-derived zone changes `dateTimeOriginal` (UTC instant) and `time_zone`, not `localDateTime`. Our `localDateTime()` (`src/process/exif.ts:118-124`) already returns the wall-clock time for a null zone, and it adds the zone offset back for a known zone, so the wall time is the same before and after.

Current project behaviour: `src/process/exif.ts:77-111` takes the zone only from `OffsetTimeOriginal`/`OffsetTime` through `formatZone` and stores `UTC+N` strings; `latitude`/`longitude` are extracted but no city/state/country or GPS zone is written (`exifStatement`, `src/process/consumer.ts:17-35`, has no `city`/`state`/`country` columns in its INSERT). The design spec defers both (`docs/superpowers/specs/2026-10-12-immich-cloudflare-design.md:169`, `:198`).

## 3. Cloudflare design options

### Measured dataset (cities500, filtered as Immich does)

- 228,820 rows. SQLite file with `id, name, lat, lon, cc, admin1, admin2, cell`: table 16.0 MB. Adding `alternateNames` takes the table to about 33 MB (15.96 MB of raw alternate-name text, 193,751 rows non-empty).
- Index `(cell, lon)`: 4.6 MB. Index on `name COLLATE NOCASE`: 4.4 MB. Without alternate names the whole database is 25.0 MB; with them 42.3 MB.
- FTS5 trigram index (contentless, `detail=none`) over name, admin1, admin2: 11.8 MB; adding alternate names: 28.6 MB. Whether D1's SQLite build exposes the `trigram` tokenizer is not verified here. Run `CREATE VIRTUAL TABLE ... tokenize='trigram'` against a scratch D1 database before relying on it. A contentless `detail=none` table cannot answer phrase queries, so queries must use plain trigram `MATCH` terms or fall back to `LIKE`.
- Single-statement SQL import file: 18.2 MB in 202 multi-row `INSERT` statements of at most 90 KB (gzip 4.9 MB). D1 limits: 100 KB per statement, 100 bound parameters, 2 MB per row, 5 GB per `d1 execute --file` import (https://developers.cloudflare.com/d1/platform/limits/). Inline literals avoid the 100-parameter limit.

### Option (a): D1 table plus a grid index (recommended for the Worker path)

Schema:

```sql
CREATE TABLE geo_place (
  id INTEGER PRIMARY KEY,           -- GeoNames id
  name TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL,
  cc TEXT NOT NULL, admin1 TEXT, admin2 TEXT,
  cell INTEGER NOT NULL             -- floor((lat + 90) * 4), 0.25 degree latitude band
);
CREATE INDEX geo_place_cell_lon ON geo_place (cell, lon, lat);  -- covering for the candidate scan
CREATE TABLE geo_country (code2 TEXT PRIMARY KEY, code3 TEXT, name TEXT);   -- 252 rows
```

Lookup for point (lat, lon) and R = 25 km: `dlat = R / 111.32`, `dlon = R / (111.32 * cos(lat))` (cap near the poles). Select `id, lat, lon FROM geo_place WHERE cell BETWEEN ?lo AND ?hi AND lon BETWEEN ?a AND ?b` (two ranges when the box crosses lon ±180). Compute Haversine in the Worker over the candidates, keep those within 25 km, take the minimum, then `SELECT name, admin1, cc FROM geo_place WHERE id = ?`. This reproduces Immich's "nearest within 25 km" rule exactly. Because the index includes `lat`, the candidate scan reads only index entries.

Measured candidate counts, 3,000 random points within 0.2 degrees of a cities500 place: index entries scanned median 51, p95 303, max 743; places inside the 25 km box median 35, p95 212, max 571. D1 counts index entries scanned as rows read, so one geocode costs about 50 rows read typically, about 300 at p95, plus 1 for the winner. At 100,000 assets the whole backfill is about 5 to 6 million rows read, a few cents at most on the paid plan (25 billion per month included; $0.001 per million beyond), and within one day of the free plan's 5 million only if spread across two days. Repeat points (burst shots, the same venue) can be memoised in-isolate by rounding to 3 decimals.

Storage: about 21 MB for the core table plus index (the covering index is slightly larger than the 4.6 MB measured for `(cell, lon)`), about 25 to 27 MB with the name index. With alternate names about 42 to 45 MB. D1 limit is 10 GB; paid storage includes 5 GB. Storage cost is zero in practice.

Import: generate `INSERT` SQL files from the three GeoNames files (a script under `scripts/`), in files of a few MB, then `wrangler d1 execute immich --remote --file=geo-places-N.sql` (https://developers.cloudflare.com/d1/best-practices/import-export-data/). Rows written: each row writes the table entry plus each index entry. With two secondary indexes that is roughly 3 writes per place, so about 690,000 rows written for one import. This exceeds the free plan's 100,000 per day, so the import needs the paid plan (50 million per month included) or splitting across days on free. Estimated wall time is about 30 to 120 seconds for the 18 MB file on the paid plan; this is an estimate and is not measured against D1. A new import for refreshed data should load `geo_place_new`, then rename in a single migration, so the table is never empty. Record the dataset date in a one-row `server_state` entry (the equivalent of Immich's `reverse-geocoding-state` metadata, `lastUpdate`, `lastImportFileName`).

Country fallback: store a Natural Earth polygon table `geo_country_poly (id, code3, min_lat, max_lat, min_lon, max_lon, ring TEXT)` with one row per polygon part and a bounding-box index; query by bounding box, then run point-in-polygon in the Worker. Use the Natural Earth 10m file for parity with Immich (4.7 MB geojson; Immich keeps only outer rings). The 50m file is 1.0 MB and the 110m file 210 KB; both are coarser and move coastal points between countries or to null. The ring for the largest polygons must stay under the 2 MB row limit; split a ring into chunks if it does not. The 10m file's polygon part count was not measured; expect low thousands. Country names and alpha-2/alpha-3 pairs fit in a 252-row table or a 10 KB constant in the Worker.

`/search/places`: Immich uses Postgres trigram word similarity over name, admin1, admin2 and alternate names. In D1 the options are a prefix `LIKE` on a `NOCASE` name index (4.4 MB, no alternate names, cheap) or an FTS5 trigram table (11.8 MB without, 28.6 MB with alternate names, tokenizer availability unverified). Start with prefix `LIKE` on `name` plus an FTS5 or `LIKE '%x%'` fallback on `admin1`; add alternate names only if non-English place search matters. Return the same `{ name, latitude, longitude, admin1name?, admin2name? }` shape with `limit 20`.

### Option (b): do it in the media container

The `media` container (`containers/media/Dockerfile`) already installs `libimage-exiftool-perl`. exiftool's `-api geolocation` (the same database Immich enables with `geolocation: true`) returns `GeolocationCity`, `GeolocationRegion`, `GeolocationCountry` and `GeolocationTimeZone` without any dataset import. That covers only the container paths (videos and large images, `src/process/video.ts`, `large-image.ts`, `exiftool-map.ts`). The common JPEG path runs in the Worker through `exifr`, and the container scales to zero, so using it for every lookup adds a cold start and the container-call cost per asset. Its city and region names come from exiftool's own database (a different source than GeoNames `cities500`), so values differ from Immich's for the same coordinates and would differ between Worker-processed and container-processed assets. Not recommended as the primary path. It is useful for time zone on container-processed assets only if exact `geo-tz` parity is wanted (see below).

A bundled alternative also exists: pack the dataset into the Worker as a binary module. Measured: 228,820 records packed as `int32 lat, int32 lon, uint32 name offset, uint16 admin id` plus a name string table and an admin table: 6.7 MB raw, 3.7 MB gzip. The Worker size limit is 64 MiB (https://developers.cloudflare.com/workers/platform/limits/), so it fits, and lookups read zero D1 rows. Costs: startup must stay under 1 second, a 6.7 MB buffer is held in every isolate, and every dataset refresh is a deploy. Prefer D1 because `/search/places` also needs a database and because refreshes then need no deploy.

### Option (c): time zone library for Workers

| Library | Version | Licence | Unpacked size | Runs in Workers | Accuracy |
|---|---|---|---|---|---|
| `@photostructure/tz-lookup` | 11.7.0 | CC0-1.0 | 88 KB | Yes in principle (pure JS, no dependencies, no `fs`; not run under workerd in this research) | Lossy compression. Upstream README: roughly 30% of random global points differ from `geo-tz`, about 10% for inhabited points, about 5% when zones with equal offsets are treated as equal (for example `Europe/Vienna` and `Europe/Berlin`). Errors cluster near borders far from populated areas |
| `tz-lookup` | 6.1.25 | CC0-1.0 | 152 KB | Yes | Same algorithm on an older boundary set; unmaintained since 2020 |
| `geo-tz` | 8.1.10 | MIT (data ODbL) | 74.6 MB | No as shipped: reads data files through `fs` | Exact, as Immich |

Recommendation: `@photostructure/tz-lookup`, called from `extractExif` when the file has GPS and no offset tag. It adds under 100 KB to the bundle and about 0.05 ms per call (upstream figure). The timezone-boundary-builder data underneath is ODbL; the package itself is CC0, so state the attribution in the README. If exact `geo-tz` parity is required later, run `geo-tz` in the container behind a `/tz?lat&lon` route and use it only on container paths, or batch the Worker backfill through it once. Verify the package bundles under `wrangler` before committing to it (one test file importing it in `test/`).

Applying the zone: mirror Immich's order. A tag offset (existing `formatZone` path) wins; otherwise use the GPS IANA zone; otherwise null. For an IANA zone, `exifr` revives the wall-clock string as UTC (`src/process/exif.ts:57-62`), so the UTC instant is `wall - offset(zone, wall)`. Compute the offset with `Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })` at the wall-clock instant, then once more at the corrected instant to handle DST transitions. Store the IANA name in `asset_exif.time_zone` (Immich stores `Europe/Zurich` in this case, `UTC+2` for offset-derived zones). `localDateTime()` must then accept an IANA name: with a known zone and a wall-clock `dateTimeOriginal`, `local_date_time` is the wall clock marked UTC, the same value as before.

### Where to wire it

- Extraction: add `city`, `state`, `country` to `ExtractedExif` and to `exifStatement` (`src/process/consumer.ts:17-35`), including them in the `ON CONFLICT` update with `keepLocked` on `latitude`/`longitude` unchanged. Immich locks only the properties the user edited, so city, state and country are recomputed whenever coordinates change. Geocode after extraction in `processAsset`, `processVideo` and `processLargeImage` (all three feed `markReady`), so one helper called inside `markReady` covers every path. Respect `reverseGeocoding.enabled` in system config.
- Manual location edits: `src/assets/update.ts:174-181` writes `latitude`/`longitude` and a lock. It should geocode the new point in the same batch and write city/state/country, so edited assets do not keep the old place. In Immich a coordinate edit goes through `AssetService.updateExif` (`src/services/asset.service.ts:116`, `:160-172`) and a sidecar write; the re-geocode then happens when extraction re-reads the sidecar (not traced further here).
- `GET /map/reverse-geocode`: replace the stub (`src/map/routes.ts:38-48`) with the lookup and return a one-element array, as Immich does.
- `GET /search/places`: replace the stub (`src/search/routes.ts:231-234`).
- Immich also sets `fileCreatedAt = dateTimeOriginal` on extraction (`metadata.service.ts:377`). `markReady` here updates `local_date_time` only (`src/process/consumer.ts:148-166`), and `file_created_at` stays at the upload value. Decide whether to match Immich when a GPS zone changes `dateTimeOriginal`; this research did not find where our timeline orders by `file_created_at` versus `local_date_time`.

## 4. Backfill of existing assets

Candidates: `SELECT asset_id FROM asset_exif WHERE latitude IS NOT NULL AND longitude IS NOT NULL AND city IS NULL` for geocoding, and the same filter with `time_zone IS NULL` for zones. Use `UPDATE ... WHERE ... AND instr(COALESCE(locked_properties,''), '"timeZone"') = 0` so edited properties are kept.

Re-running the full queue (`PUT /jobs/metadataExtraction` with `force`, `src/jobs/routes.ts:82-100`) re-reads every original from R2 and re-renders thumbnails (`processAsset` regenerates both), which is far more work than needed. Add a metadata-only backfill: a cron or admin-triggered loop in `src/jobs/` that reads coordinates from D1 (no R2 read), computes city/state/country and the GPS zone, and writes with `commit(db, [...tracked(UPDATE asset_exif ...)])`. `exifr` is not needed because the date and coordinates already sit in `asset_exif` (`date_time_original` holds the wall clock marked UTC when `time_zone` was null). The backfill converts it with the new zone: `utc = wall - offset(zone)`, `UPDATE asset_exif SET date_time_original = ?, time_zone = ?, city = ?, state = ?, country = ?, update_id = :cursor` (one statement per asset; D1 batches carry many statements, each binds about 8 parameters, well below 100 per statement).

Sync events. `asset_exif` rows carry `update_id` and the stream pass `exifs` (`src/sync/passes.ts:125-130`, entity `AssetExifV1`) selects `update_id > cursor` for the owner. The mapper already sends `city`, `state`, `country`, `timeZone` and `dateTimeOriginal` (`:64-75`). So each backfilled asset produces one `AssetExifV1` upsert (also `AlbumAssetExifV1`/`PartnerAssetExifV1` for album and partner streams, `:180-182`). The assets stream emits `AssetV1` only if the `assets` row also gets a `tracked` update; if the backfill touches `local_date_time` (it need not, since the value does not change for wall-clock EXIF), `AssetV1` is resent too.

Mobile effect. The timeline groups remote assets by `localDateTime` (falling back to `createdAt`, `lib/infrastructure/repositories/timeline.repository.dart:737-740`, mobile source). Because `localDateTime` is unchanged for photos with a wall-clock EXIF time, buckets and ordering do not move. The updated exif rows change what the asset detail sheet shows (location text from city/state/country, local time with zone from `timeZone` and `dateTimeOriginal`), and populate the Places and search filter lists. Cases where `localDateTime` does change: assets whose EXIF time ends in `Z` or `+00:00`, videos (`defaultVideosToUTC`) with GPS, or assets that previously had no zone and an EXIF time stored as a true UTC instant. Compute the new local time as `utc + offset(new zone)` for those and update `assets.local_date_time` with a `tracked` assets update so `AssetV1` is emitted; the mobile client then moves the asset between day buckets when it applies the event (`sync_stream.repository.dart:237-248`, `:286-297` use `asset.localDateTime` as the bucket key).

Volume and pacing. Page through candidates by `asset_id` in chunks of 200 to 500 per invocation (D1 30-second query limit, Worker CPU limit 300,000 ms configured), 60 to 500 rows read per geocode, writes about 3 to 4 rows per asset (table plus the `asset_exif_owner_update` and place indexes). For 100,000 geotagged assets: about 6 million rows read, about 400,000 rows written, minutes of runtime. Clients pulling sync afterwards receive 100,000 exif events in pages (page size in `ctx.pageSize`); this is the same volume as a first sync of exif.

Idempotence: the filter `city IS NULL` plus `reverseGeocoding.enabled` makes reruns safe. Assets whose coordinates fall outside any city and polygon stay `city IS NULL`, so also record a marker (for example set `country` when found, and keep a separate `geocoded_at` column or process by `update_id` watermark) to avoid reprocessing ocean points on every run.

## Open items to verify before implementation

1. D1 build supports the FTS5 `trigram` tokenizer (needed only for the places search option).
2. `@photostructure/tz-lookup` bundles and runs under workerd, and `Intl.DateTimeFormat` `timeZoneName: 'longOffset'` returns offsets in workerd.
3. Number of polygon parts and maximum ring size in `ne_10m_admin_0_countries.geojson` v5.1.2 against the 2 MB row limit.
4. D1 import wall time for the 18 MB SQL file (estimate only above).
5. Where the timeline orders by `file_created_at` and whether a GPS-derived zone should move it.
