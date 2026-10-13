# Phase 2 stream G: metadata search and map

## Tables and migrations
No new tables. `migrations/0070_search_indexes.sql` adds D1 indexes only: `assets (owner_id, file_created_at)`, `assets (owner_id, created_at)`, `asset_exif (owner_id, city)`, `(owner_id, country, state, city)`, `(owner_id, make, model)`, `(owner_id, lens_model)`, and a partial index on coordinates. No sync types.

## Endpoints
Implemented (owner-scoped, `requireAuth`):
- `POST /search/metadata`: flat (deprecated) shape with `page`/`size`/`order` and `nextPage`, and the 3.2+ structured shape (`filter`, `orderBy`, `cursor`, `or` branches) with `nextCursor`. Mixing both shapes is 400, as in Immich.
- `POST /search/statistics`, `POST /search/random`, `POST /search/large-assets` (filters arrive as query parameters, per the contract).
- `GET /search/suggestions` (country, state, city, camera-make, camera-model, camera-lens-model; `includeNull`), `GET /search/cities`, `GET /search/explore`.
- `GET /map/markers` (own assets with coordinates; `isArchived`, `isFavorite`, `fileCreatedAfter/Before`).

Deferred to phase 4, returning Immich-shaped empty results: `POST /search/smart` (empty `SearchResponseDto`; `features.smartSearch` stays false so clients do not call it), `GET /search/person` (`[]`, no people until stream with faces), `GET /search/places` and `GET /map/reverse-geocode` (`[]`, need the geo dataset).

## Immich behaviours matched
- Flat filters: created/updated/trashed/taken before/after (inclusive), type, visibility, favourite, make/model/lens/city/state/country (null matches NULL), rating, originalFileName/originalPath/description (case-insensitive contains), deviceId is not in the Immich DTO and is accepted as an extension, `withDeleted` (implied by trashed filters), `isMotion`, `isOffline` (always false), `withExif`.
- Default (no visibility): everything except `locked`. Explicit `visibility=locked` returns 401 since elevated sessions (PIN) are not implemented yet.
- Ordering: flat `fileCreatedAt` + `id` by `order`; structured `orderBy` field/direction with id tie-break, nullable columns last.
- Response: `total`/`count` equal the page length, as in Immich.
- Suggestions: distinct non-empty values for timeline-visible, non-trashed assets, plus `null` if `includeNull`.

## Deferrals inside implemented endpoints
- Filters on albums, people, tags, `ocr`, libraries, `isEncoded`, encoded video path: no such data exists yet, so a positive match requirement yields no results and a negative one is a no-op. Other streams add real predicates in `src/search/criteria.ts`.
- Partner and shared-album scope (`withPartners`, `withSharedAlbums`): ignored, owner only.
- Accent-insensitive text match (`f_unaccent`): D1 has no unaccent; `LIKE` is ASCII case-insensitive.
- `SearchResponseDto.albums` is always empty; `facets` are empty.
