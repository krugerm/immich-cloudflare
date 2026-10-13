# Immich on Cloudflare, Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Cloudflare Worker that implements enough of the Immich 3.3 API for the stock Immich iOS app to log in, back up photos, and browse them, and for the Immich web app (served from the same Worker) to show the timeline and open photos.

**Architecture:** One Worker (`immich-cf`) serves `/api/*` with Hono, serves the prebuilt Immich web app as static assets, consumes two queues (`asset-process`, `asset-backup`) and runs two crons. State lives in D1 (catalogue, sessions, sync cursors) and R2 (originals and thumbnails in `immich-media`, copies in `immich-originals-backup`). Every synced row gets its own monotonic cursor from a `seq` row inside the D1 transaction.

**Tech Stack:** TypeScript, Cloudflare Workers, Hono 4, D1, R2, Queues, Images binding, Workers rate limiting, Vitest with `@cloudflare/vitest-pool-workers`, `openapi-typescript`, `exifr`, `thumbhash`, `fast-png`, `aws4fetch`.

**Spec:** `docs/superpowers/specs/2026-10-12-immich-cloudflare-design.md` (sections 3–10; this plan covers phase 1 of section 9).

## Global Constraints

- Compatibility target: Immich mobile and web 3.3.x; `/server/version` reports `3.3.0` (`{major: 3, minor: 3, patch: 0, prerelease: null}`).
- Pinned API contract: `vendor/immich-openapi.json`, copied from Immich commit `cc7fd671973085baf2a0dfba4e2b0a86cab17e6c` (`open-api/immich-openapi-specs.json`, version `3.3.0-rc.0`).
- Entity IDs are UUIDv4 (`crypto.randomUUID()`). Update cursors are `00000000-0000-7000-8000-<12 hex digits>` strings from the `seq` row, one bump per written row, assigned inside the D1 batch.
- Only `src/db/changes.ts` writes rows that carry `update_id`. Never write one `UPDATE` that touches several synced rows.
- Error bodies: `{message, error, statusCode, correlationId}`; `correlationId` is the `cf-ray` header or a random UUID.
- Password hashes: `pbkdf2-sha256$100000$<salt b64>$<hash b64>`; 100,000 iterations is the Workers maximum.
- Cookies on login: `immich_access_token` (HttpOnly), `immich_auth_type=password` (HttpOnly), `immich_is_authenticated=true` (not HttpOnly); all `Path=/`, `SameSite=Lax`, `Secure`, `Max-Age=34560000`.
- Token lookup order: `x-immich-user-token`, `x-immich-session-token`, `?sessionKey=`, `Authorization: Bearer`, `immich_access_token` cookie.
- Upload body cap is Cloudflare's 100 MB edge limit; the Worker never buffers a whole file larger than one 10 MiB part.
- Sync stream: closes normally (never with an error) and stops before 950 D1 queries per invocation.
- No AI attribution in commits.

## Spec deviations (agreed in this plan)

- Contract checks use a small in-repo validator over `vendor/immich-openapi.json` (`test/contract.ts`) in place of generated Zod schemas: it runs inside workerd, validates `required`, types, `nullable`, `enum` and `pattern` (which catches UUIDv7 IDs and bad date strings), and needs no code generator.
- `assets.checksum` is stored as base64 text (the form every Immich DTO uses) in place of a 20-byte blob.
- Video metadata (creation date, GPS) is deferred to the phase 3 `media` container. Phase 1 videos use the client's `fileCreatedAt`, which the phone sets from the photo library's creation date.
- Phase 1 serves `/assets/{id}/video/playback` from the original file (no transcode).

Task 17 updates the spec to match.

## Review Focus

1. **Re-uploading the same photo** (app reinstall, second device): must return `200 {status: "duplicate"}` with the existing ID and leave exactly one R2 object. Pinned in Task 8 (`duplicate upload deletes the new object`).
2. **A client that stops mid-upload** (phone loses signal): no asset row, no orphaned multipart upload. Pinned in Task 8 (`truncated body aborts and inserts nothing`).
3. **First sync of a library larger than one invocation's query budget**: the stream ends cleanly without `SyncCompleteV1`, and the next stream resumes from the acked checkpoint with no gaps or repeats. Pinned in Task 11 (`stream stops at query budget and resumes`).
4. **Two rows written in one batch around a page boundary**: both reach the client. Pinned in Task 4 (`each tracked row gets its own cursor`) and Task 11 (`rows sharing a commit straddle a page boundary`).
5. **A photo the Images binding can't read** (corrupt JPEG, RAW, file over 20 MB): the asset still appears in the timeline with `status` `failed` or `needs_media`, and the thumbnail endpoint returns 404 `no-store`. Pinned in Task 10 (`unsupported input marks needs_media`) and Task 12 (`missing thumbnail is 404 no-store`).

---

## File Structure

```
package.json, tsconfig.json, wrangler.jsonc, vitest.config.ts, .dev.vars.example
vendor/immich-openapi.json          pinned Immich API contract
migrations/0001_init.sql            D1 schema
scripts/build-web.sh                builds Immich web at the pinned commit into public/
src/index.ts                        Worker entry: fetch, queue, scheduled
src/app.ts                          Hono app, route mounting, error handlers
src/gen/immich.d.ts                 generated OpenAPI types (openapi-typescript)
src/gen/dto.ts                      Dto<'Name'> helper type
src/http/errors.ts                  ImmichError, error body, onError/notFound
src/db/changes.ts                   cursor-bumping writer: tracked(), commit(), nowCursor()
src/db/rows.ts                      row types for D1 tables
src/auth/password.ts                PBKDF2 hash/verify
src/auth/session.ts                 token extraction, session create/find, requireAuth middleware
src/auth/routes.ts                  /auth/login, /auth/logout, /auth/validateToken, /auth/admin-sign-up
src/users/repo.ts                   insertUser, getUserById, countUsers
src/users/map.ts                    UserAdminResponseDto, SyncAuthUserV2, SyncUserV1 mappers
src/users/routes.ts                 /users/me, /users/me/preferences
src/defaults/user-preferences.json  captured default preferences
src/server/routes.ts                /server/*, /.well-known/immich
src/upload/media-types.ts           accepted extensions, asset type by extension
src/upload/multipart.ts             streaming multipart/form-data parser
src/upload/r2-writer.ts             streaming SHA-1 + R2 multipart writer
src/upload/routes.ts                POST /assets, POST /assets/bulk-upload-check
src/process/exif.ts                 EXIF extraction from a buffer
src/process/thumbs.ts               Thumbnailer interface + Images binding implementation + thumbhash
src/process/consumer.ts             asset-process queue consumer
src/sync/acks.ts                    ack parsing, checkpoint read/write, reset
src/sync/passes.ts                  per-entity-type queries and mappers
src/sync/routes.ts                  /sync/stream, /sync/ack
src/media/routes.ts                 thumbnail, original, video/playback
src/assets/map.ts                   AssetResponseDto mapper
src/assets/routes.ts                GET /assets/:id, viewer stubs
src/timeline/routes.ts              /timeline/buckets, /timeline/bucket
src/cron/purge.ts                   daily trash purge
src/backup/consumer.ts              asset-backup consumer (S3 CopyObject)
src/cron/index.ts                   cron dispatcher (purge, backup re-enqueue)
test/apply-migrations.ts            vitest setup
test/contract.ts                    OpenAPI response validator
test/helpers.ts                     createUser, login, uploadAsset helpers
test/fixtures/                      captured reference responses and sample media
test/*.test.ts                      tests per module
```

---

### Task 1: Capture reference behaviour from a real Immich server

Real responses become fixtures for later tasks: default user preferences, the web app's request list, and a sync stream for the golden test in Task 16.

**Files:**
- Create: `test/fixtures/immich-3.3.0/README.md`
- Create: `test/fixtures/immich-3.3.0/user-preferences.json`, `server-features.json`, `server-config.json`, `asset-response.json`, `timeline-buckets.json`, `timeline-bucket.json`, `web-requests.txt`
- Create: `test/fixtures/media/sample.jpg`, `test/fixtures/media/sample.heic`, `test/fixtures/media/no-exif.png`

**Interfaces:**
- Produces: fixture files above. Task 6 copies `user-preferences.json` into `src/defaults/`. Task 13 checks its timeline output against `timeline-buckets.json` field shapes. Task 16 uses the running server again.

- [ ] **Step 1: Initialise the repo files and fixture folders**

```bash
cd immich-cloudflare
mkdir -p test/fixtures/immich-3.3.0 test/fixtures/media vendor
cp <immich-source-checkout>/open-api/immich-openapi-specs.json vendor/immich-openapi.json \
  || curl -fsSL https://raw.githubusercontent.com/immich-app/immich/cc7fd671973085baf2a0dfba4e2b0a86cab17e6c/open-api/immich-openapi-specs.json -o vendor/immich-openapi.json
node -e "console.log(require('./vendor/immich-openapi.json').info.version)"
```

Expected: `3.3.0-rc.0`.

- [ ] **Step 2: Start a disposable Immich on the build host**

Find the image tag that matches the pinned commit, then start Immich's stock compose file on a Linux x86_64 Docker host (`<build-host>` below).

```bash
ssh <build-host> 'curl -fsSL "https://api.github.com/repos/immich-app/immich/releases?per_page=10" | grep -oE "\"tag_name\": \"v3\.3[^\"]*\"" | head -5'
```

Pick the newest `v3.3.*` tag (an `-rc` tag is acceptable). Then:

```bash
ssh <build-host> 'set -e; mkdir -p ~/immich-ref && cd ~/immich-ref
curl -fsSL -o docker-compose.yml https://github.com/immich-app/immich/releases/download/<TAG>/docker-compose.yml
curl -fsSL -o .env https://github.com/immich-app/immich/releases/download/<TAG>/example.env
sed -i "s/^IMMICH_VERSION=.*/IMMICH_VERSION=<TAG>/" .env
sed -i "s#- 2283:2283#- 127.0.0.1:2290:2283#" docker-compose.yml
docker compose up -d
sleep 40; curl -fsS http://127.0.0.1:2290/api/server/ping'
```

Expected: `{"res":"pong"}`.

(The `sed` edits touch only the throwaway compose file on the build host.)

- [ ] **Step 3: Create the admin, log in, upload two samples, and save JSON fixtures**

Put a JPEG with EXIF date and GPS at `test/fixtures/media/sample.jpg`, an iPhone HEIC at `test/fixtures/media/sample.heic` (any personal photo exported from Photos as HEIC; strip GPS first with `exiftool -gps:all= sample.heic` if it should not be committed), and a small PNG without EXIF at `test/fixtures/media/no-exif.png`. Keep each under 5 MB.

```bash
scp test/fixtures/media/sample.jpg test/fixtures/media/sample.heic <build-host>:~/immich-ref/
ssh <build-host> 'cd ~/immich-ref; B=http://127.0.0.1:2290/api
curl -fsS -X POST $B/auth/admin-sign-up -H "content-type: application/json" -d "{\"email\":\"ref@example.com\",\"password\":\"refpass123\",\"name\":\"Ref\"}" >/dev/null
T=$(curl -fsS -X POST $B/auth/login -H "content-type: application/json" -d "{\"email\":\"ref@example.com\",\"password\":\"refpass123\"}" | python3 -c "import sys,json;print(json.load(sys.stdin)[\"accessToken\"])")
echo $T > token
for f in sample.jpg sample.heic; do curl -fsS -X POST $B/assets -H "x-immich-user-token: $T" -F deviceAssetId=$f -F deviceId=ref -F fileCreatedAt=2024-05-04T10:00:00.000Z -F fileModifiedAt=2024-05-04T10:00:00.000Z -F assetData=@$f; echo; done
sleep 20
curl -fsS $B/users/me/preferences -H "x-immich-user-token: $T" > user-preferences.json
curl -fsS $B/server/features > server-features.json
curl -fsS $B/server/config > server-config.json
curl -fsS "$B/timeline/buckets?visibility=timeline" -H "x-immich-user-token: $T" > timeline-buckets.json
BUCKET=$(python3 -c "import json;print(json.load(open(\"timeline-buckets.json\"))[0][\"timeBucket\"])")
curl -fsS "$B/timeline/bucket?visibility=timeline&timeBucket=$BUCKET" -H "x-immich-user-token: $T" > timeline-bucket.json
ID=$(python3 -c "import json;print(json.load(open(\"timeline-bucket.json\"))[\"id\"][0])")
curl -fsS $B/assets/$ID -H "x-immich-user-token: $T" > asset-response.json'
scp '<build-host>:~/immich-ref/{user-preferences,server-features,server-config,timeline-buckets,timeline-bucket,asset-response}.json' test/fixtures/immich-3.3.0/
```

Expected: six JSON files; `timeline-buckets.json` looks like `[{"timeBucket":"2024-05-01","count":2}]`.

- [ ] **Step 4: Record the web app's requests**

Use a browser to open `http://localhost:2290` through an SSH tunnel (`ssh -L 2290:127.0.0.1:2290 <build-host>`), log in as `ref@example.com`, wait for the timeline, open one photo, close it. Export the network log and keep only `/api/` request lines as `METHOD path?query` (IDs replaced with `{id}`), sorted and de-duplicated, in `test/fixtures/immich-3.3.0/web-requests.txt`.

Expected: the list contains at least `/api/server/config`, `/api/users/me`, `/api/timeline/buckets`, `/api/timeline/bucket`, `/api/assets/{id}`, `/api/assets/{id}/thumbnail`. Any endpoint in the list that this plan does not implement must be added to Task 14's stub list before Task 14 starts.

- [ ] **Step 5: Write the fixture README and commit**

`test/fixtures/immich-3.3.0/README.md`:

```markdown
Captured from Immich <TAG> (commit matching vendor/immich-openapi.json) on a Linux x86_64 Docker host, 2026-10-12.
Server: docker compose in ~/immich-ref, bound to 127.0.0.1:2290, admin ref@example.com / refpass123.
Files are raw API responses; web-requests.txt is the de-duplicated /api request list from loading the web timeline and opening one photo.
Leave ~/immich-ref running until Task 16 (golden sync test) is done, then `docker compose down -v`.
```

```bash
git add vendor test/fixtures
git commit -m "Add pinned Immich OpenAPI contract and reference fixtures"
```

---

### Task 2: Project scaffold, error shape, ping endpoint, contract validator

**Files:**
- Create: `package.json` (via npm), `tsconfig.json`, `wrangler.jsonc`, `vitest.config.ts`, `.gitignore`, `.dev.vars.example`
- Create: `src/index.ts`, `src/app.ts`, `src/http/errors.ts`, `src/gen/dto.ts`, `src/gen/immich.d.ts` (generated), `worker-configuration.d.ts` (generated)
- Create: `test/apply-migrations.ts`, `test/contract.ts`, `test/scaffold.test.ts`
- Create: `migrations/0000_empty.sql` (placeholder so `readD1Migrations` finds the folder; Task 3 adds the real schema)

**Interfaces:**
- Produces: `app` (Hono instance, `AppEnv` type) from `src/app.ts`; `api` sub-router mounted at `/api`; `ImmichError(status, message)`; `Dto<'SchemaName'>` type; `expectSchema(name, value)` and `expectResponse(path, method, status, body)` test helpers.

- [ ] **Step 1: Install dependencies**

```bash
cd immich-cloudflare
npm init -y
npm pkg set type=module private=true name=immich-cloudflare
npm pkg delete main
npm i hono exifr thumbhash fast-png aws4fetch
npm i -D wrangler @cloudflare/vitest-pool-workers vitest typescript openapi-typescript
npm pkg set scripts.dev="wrangler dev" scripts.deploy="wrangler deploy" scripts.test="vitest run" scripts.typecheck="tsc --noEmit" scripts.gen="openapi-typescript vendor/immich-openapi.json -o src/gen/immich.d.ts && wrangler types"
```

If `npm i` reports a peer conflict between `vitest` and `@cloudflare/vitest-pool-workers`, install the `vitest` version named in the pool package's `peerDependencies` (`npm view @cloudflare/vitest-pool-workers peerDependencies`).

- [ ] **Step 2: Write config files**

`wrangler.jsonc`:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "immich-cf",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-01",
  "compatibility_flags": ["nodejs_compat"],
  "limits": { "cpu_ms": 300000 },
  "assets": {
    "directory": "./public",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*", "/.well-known/*"]
  },
  "d1_databases": [
    { "binding": "DB", "database_name": "immich", "database_id": "00000000-0000-0000-0000-000000000000", "migrations_dir": "migrations" }
  ],
  "r2_buckets": [
    { "binding": "MEDIA", "bucket_name": "immich-media" },
    { "binding": "BACKUP", "bucket_name": "immich-originals-backup" }
  ],
  "queues": {
    "producers": [
      { "binding": "PROCESS_QUEUE", "queue": "asset-process" },
      { "binding": "BACKUP_QUEUE", "queue": "asset-backup" }
    ],
    "consumers": [
      { "queue": "asset-process", "max_batch_size": 5, "max_retries": 5, "retry_delay": 30, "dead_letter_queue": "asset-process-dlq" },
      { "queue": "asset-backup", "max_batch_size": 10, "max_retries": 5, "retry_delay": 60, "dead_letter_queue": "asset-backup-dlq" }
    ]
  },
  "images": { "binding": "IMAGES" },
  "ratelimits": [{ "name": "LOGIN_LIMITER", "namespace_id": "1001", "simple": { "limit": 10, "period": 60 } }],
  "triggers": { "crons": ["17 3 * * *", "41 4 * * 0"] },
  "vars": {
    "SERVER_VERSION": "3.3.0",
    "MEDIA_BUCKET_NAME": "immich-media",
    "BACKUP_BUCKET_NAME": "immich-originals-backup",
    "R2_ACCOUNT_ID": ""
  }
}
```

`.dev.vars.example` (copy to `.dev.vars` for `wrangler dev`; values come from a secret manager at deploy time, Task 17):

```
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "es2022",
    "moduleResolution": "bundler",
    "lib": ["es2022"],
    "types": ["@cloudflare/vitest-pool-workers"],
    "strict": true,
    "noEmit": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "isolatedModules": true
  },
  "include": ["src", "test", "worker-configuration.d.ts"]
}
```

`vitest.config.ts`:

```ts
import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
      poolOptions: {
        workers: {
          singleWorker: true,
          wrangler: { configPath: './wrangler.jsonc' },
          miniflare: {
            bindings: {
              TEST_MIGRATIONS: migrations,
              R2_ACCESS_KEY_ID: 'test',
              R2_SECRET_ACCESS_KEY: 'test',
              R2_ACCOUNT_ID: 'testacct',
              // Tests call consumers directly; background delivery would race with assertions.
              DISABLE_QUEUE_CONSUMERS: 'true',
            },
          },
        },
      },
    },
  };
});
```

If the installed `@cloudflare/vitest-pool-workers` no longer exports `defineWorkersConfig`, follow the configuration example in `node_modules/@cloudflare/vitest-pool-workers/README.md` with the same options (wrangler config path, the migrations binding, the three test bindings, the setup file). If Miniflare rejects the `images` binding, add `miniflare: { ... }` overrides that drop it for tests; no test uses `env.IMAGES` directly (Task 10 injects a fake).

`.gitignore`:

```
node_modules
.wrangler
.dev.vars
public
dist
```

`migrations/0000_empty.sql`:

```sql
-- intentionally empty; schema starts in 0001_init.sql
SELECT 1;
```

`test/apply-migrations.ts`:

```ts
import { applyD1Migrations, env } from 'cloudflare:test';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

- [ ] **Step 3: Generate types**

```bash
mkdir -p public src/gen && echo '<!doctype html><title>Immich</title>' > public/index.html
npm run gen
```

Expected: `src/gen/immich.d.ts` and `worker-configuration.d.ts` exist; the latter declares `interface Env` with `DB`, `MEDIA`, `BACKUP`, `PROCESS_QUEUE`, `BACKUP_QUEUE`, `IMAGES`, `LOGIN_LIMITER`, `ASSETS` and the vars. Create `test/env.d.ts` with the test-only binding so tests typecheck:

```ts
declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}
```

Secrets and test-only flags are invisible to `wrangler types`, so declare them in `src/gen/env.d.ts` (a declaration merge that survives regeneration):

```ts
interface Env {
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  DISABLE_QUEUE_CONSUMERS?: string;
}
```

Both files sit under the `include` globs in `tsconfig.json`, and `npm run gen` can overwrite `worker-configuration.d.ts` without losing them.

`src/gen/dto.ts`:

```ts
import type { components } from './immich';

export type Dto<K extends keyof components['schemas']> = components['schemas'][K];
```

- [ ] **Step 4: Write the contract validator**

`test/contract.ts`:

```ts
import spec from '../vendor/immich-openapi.json';

type Schema = Record<string, any>;
const schemas = (spec as any).components.schemas as Record<string, Schema>;

function resolve(name: string): Schema {
  const s = schemas[name];
  if (!s) throw new Error(`unknown schema ${name}`);
  return s;
}

export function validate(schema: Schema | string, value: unknown, path = '$'): string[] {
  const s: Schema = typeof schema === 'string' ? resolve(schema) : schema;
  if (value === null && s.nullable) return [];
  if (s.$ref) return validate(resolve(s.$ref.split('/').pop()!), value, path);
  if (value === null) return [`${path}: null not allowed`];
  if (s.allOf) return s.allOf.flatMap((x: Schema) => validate(x, value, path));
  const alternatives = s.oneOf ?? s.anyOf;
  if (alternatives) {
    return alternatives.some((x: Schema) => validate(x, value, path).length === 0) ? [] : [`${path}: matches no alternative`];
  }
  const errors: string[] = [];
  if (s.enum && !s.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
  switch (s.type) {
    case 'string':
      if (typeof value !== 'string') return [`${path}: expected string, got ${typeof value}`];
      if (s.pattern && !new RegExp(s.pattern).test(value)) errors.push(`${path}: ${JSON.stringify(value)} does not match pattern`);
      break;
    case 'integer':
      if (!Number.isInteger(value)) errors.push(`${path}: expected integer, got ${JSON.stringify(value)}`);
      break;
    case 'number':
      if (typeof value !== 'number') errors.push(`${path}: expected number, got ${typeof value}`);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(`${path}: expected boolean, got ${typeof value}`);
      break;
    case 'array':
      if (!Array.isArray(value)) return [`${path}: expected array`];
      value.forEach((v, i) => errors.push(...validate(s.items, v, `${path}[${i}]`)));
      break;
    default:
      if (s.type === 'object' || s.properties) {
        if (typeof value !== 'object' || Array.isArray(value)) return [`${path}: expected object`];
        const obj = value as Record<string, unknown>;
        for (const key of s.required ?? []) if (!(key in obj) || obj[key] === undefined) errors.push(`${path}.${key}: required`);
        for (const [key, ps] of Object.entries(s.properties ?? {})) {
          if (obj[key] !== undefined) errors.push(...validate(ps as Schema, obj[key], `${path}.${key}`));
        }
      }
  }
  return errors;
}

export function expectSchema(name: string, value: unknown): void {
  const errors = validate(name, value);
  if (errors.length) throw new Error(`${name} contract violations:\n${errors.join('\n')}`);
}

export function expectResponse(path: string, method: string, status: number, body: unknown): void {
  const op = (spec as any).paths[path]?.[method.toLowerCase()];
  if (!op) throw new Error(`no operation ${method} ${path}`);
  const schema = op.responses[String(status)]?.content?.['application/json']?.schema;
  if (!schema) throw new Error(`no JSON schema for ${method} ${path} ${status}`);
  const errors = validate(schema, body);
  if (errors.length) throw new Error(`${method} ${path} ${status} contract violations:\n${errors.join('\n')}`);
}
```

- [ ] **Step 5: Write the failing tests**

`test/scaffold.test.ts`:

```ts
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { expectResponse, validate } from './contract';

describe('scaffold', () => {
  it('answers ping', async () => {
    const res = await SELF.fetch('https://immich.test/api/server/ping');
    expect(res.status).toBe(200);
    const body = await res.json();
    expectResponse('/server/ping', 'get', 200, body);
    expect(body).toEqual({ res: 'pong' });
  });

  it('returns Immich-shaped 404 for unknown API routes', async () => {
    const res = await SELF.fetch('https://immich.test/api/nope', { headers: { 'cf-ray': 'ray123' } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: 'Not found', error: 'Not Found', statusCode: 404, correlationId: 'ray123' });
  });

  it('validator rejects a UUIDv7 where Immich requires v4', () => {
    const errors = validate('SyncAssetDeleteV1', { assetId: '0192f0c4-7d2a-7c3e-8f00-123456789abc' });
    expect(errors.join()).toContain('does not match pattern');
  });
});
```

- [ ] **Step 6: Run to see it fail**

Run: `npx vitest run test/scaffold.test.ts`
Expected: FAIL (cannot resolve `src/index.ts`).

- [ ] **Step 7: Implement**

`src/http/errors.ts`:

```ts
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

const REASONS: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Payload Too Large',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
};

export class ImmichError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function correlationId(c: Context): string {
  return c.req.header('cf-ray') ?? crypto.randomUUID();
}

export function errorBody(status: number, message: string, id: string) {
  return { message, error: REASONS[status] ?? 'Error', statusCode: status, correlationId: id };
}

export function onError(err: Error, c: Context) {
  if (err instanceof ImmichError) {
    return c.json(errorBody(err.status, err.message, correlationId(c)), err.status as ContentfulStatusCode);
  }
  console.error(err);
  return c.json(errorBody(500, 'Internal server error', correlationId(c)), 500);
}

export function notFound(c: Context) {
  return c.json(errorBody(404, 'Not found', correlationId(c)), 404);
}
```

`src/app.ts`:

```ts
import { Hono } from 'hono';
import { notFound, onError } from './http/errors';

export type AppEnv = { Bindings: Env; Variables: Record<string, unknown> };

export const api = new Hono<AppEnv>();
api.get('/server/ping', (c) => c.json({ res: 'pong' }));

export const app = new Hono<AppEnv>();
app.route('/api', api);
app.onError(onError);
app.notFound(notFound);
```

`src/index.ts`:

```ts
import { app } from './app';

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 8: Run tests and typecheck**

Run: `npx vitest run test/scaffold.test.ts && npm run typecheck`
Expected: 3 passed; no type errors.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "Scaffold Worker with Immich error shape, ping, and contract validator"
```

---

### Task 3: D1 schema

**Files:**
- Create: `migrations/0001_init.sql`
- Create: `src/db/rows.ts`
- Test: `test/schema.test.ts`

**Interfaces:**
- Produces: tables `seq`, `users`, `user_audit`, `sessions`, `sync_checkpoints`, `assets`, `asset_exif`, `asset_audit`; row types `UserRow`, `SessionRow`, `AssetRow`, `ExifRow` in `src/db/rows.ts`.

- [ ] **Step 1: Write the failing test**

`test/schema.test.ts`:

```ts
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('schema', () => {
  it('creates all tables and the seq row', async () => {
    const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all<{ name: string }>();
    const names = results.map((r) => r.name);
    for (const t of ['asset_audit', 'asset_exif', 'assets', 'seq', 'sessions', 'sync_checkpoints', 'user_audit', 'users']) {
      expect(names).toContain(t);
    }
    expect(await env.DB.prepare('SELECT v FROM seq WHERE id = 1').first('v')).toBe(0);
  });

  it('enforces one asset per owner and checksum', async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO users (id, email, name, password_hash, profile_changed_at, created_at, updated_at, update_id) VALUES ('u1', 'a@b.c', 'A', 'x', ?1, ?1, ?1, 'c')",
    ).bind(now).run();
    const insert = env.DB.prepare(
      "INSERT INTO assets (id, owner_id, device_asset_id, device_id, type, original_path, original_file_name, checksum, file_created_at, file_modified_at, local_date_time, file_size, created_at, updated_at, update_id) VALUES (?1, 'u1', 'd', 'd', 'IMAGE', 'p', 'f.jpg', 'sum', ?2, ?2, ?2, 1, ?2, ?2, 'c')",
    );
    await insert.bind('a1', now).run();
    await expect(insert.bind('a2', now).run()).rejects.toThrow(/UNIQUE/);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run test/schema.test.ts`
Expected: FAIL (`no such table`).

- [ ] **Step 3: Write the migration**

`migrations/0001_init.sql`:

```sql
CREATE TABLE seq (id INTEGER PRIMARY KEY CHECK (id = 1), v INTEGER NOT NULL);
INSERT INTO seq (id, v) VALUES (1, 0);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  is_onboarded INTEGER NOT NULL DEFAULT 1,
  avatar_color TEXT NOT NULL DEFAULT 'primary',
  profile_changed_at TEXT NOT NULL,
  quota_bytes INTEGER,
  usage_bytes INTEGER NOT NULL DEFAULT 0,
  storage_label TEXT,
  preferences TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  update_id TEXT NOT NULL
);
CREATE INDEX users_update ON users (update_id);

CREATE TABLE user_audit (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, deleted_at TEXT NOT NULL);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_sha256 TEXT NOT NULL UNIQUE,
  device_type TEXT NOT NULL DEFAULT '',
  device_os TEXT NOT NULL DEFAULT '',
  reset_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sync_checkpoints (
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  ack TEXT NOT NULL,
  PRIMARY KEY (session_id, entity_type)
);

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users (id),
  device_asset_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('IMAGE', 'VIDEO', 'AUDIO', 'OTHER')),
  original_path TEXT NOT NULL,
  original_file_name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  file_created_at TEXT NOT NULL,
  file_modified_at TEXT NOT NULL,
  local_date_time TEXT NOT NULL,
  duration INTEGER,
  is_favorite INTEGER NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL DEFAULT 'timeline',
  live_photo_video_id TEXT,
  thumbhash TEXT,
  width INTEGER,
  height INTEGER,
  file_size INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'needs_media', 'failed')),
  error TEXT,
  has_thumbnail INTEGER NOT NULL DEFAULT 0,
  backed_up_at TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  update_id TEXT NOT NULL
);
CREATE UNIQUE INDEX assets_owner_checksum ON assets (owner_id, checksum);
CREATE INDEX assets_owner_update ON assets (owner_id, update_id);
CREATE INDEX assets_owner_local_date ON assets (owner_id, local_date_time);

CREATE TABLE asset_exif (
  asset_id TEXT PRIMARY KEY REFERENCES assets (id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  make TEXT, model TEXT, lens_model TEXT, exposure_time TEXT,
  f_number REAL, focal_length REAL, iso INTEGER,
  latitude REAL, longitude REAL, city TEXT, state TEXT, country TEXT,
  date_time_original TEXT, modify_date TEXT, time_zone TEXT, orientation TEXT,
  rating INTEGER, description TEXT,
  exif_image_width INTEGER, exif_image_height INTEGER, file_size_in_byte INTEGER,
  profile_description TEXT, projection_type TEXT, fps REAL,
  update_id TEXT NOT NULL
);
CREATE INDEX asset_exif_owner_update ON asset_exif (owner_id, update_id);

CREATE TABLE asset_audit (id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, owner_id TEXT NOT NULL, deleted_at TEXT NOT NULL);
CREATE INDEX asset_audit_owner ON asset_audit (owner_id, id);
```

`src/db/rows.ts`:

```ts
export interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  is_admin: number;
  is_onboarded: number;
  avatar_color: string;
  profile_changed_at: string;
  quota_bytes: number | null;
  usage_bytes: number;
  storage_label: string | null;
  preferences: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  update_id: string;
}

export interface SessionRow {
  id: string;
  user_id: string;
  token_sha256: string;
  device_type: string;
  device_os: string;
  reset_at: string | null;
  created_at: string;
  updated_at: string;
}

export type AssetStatus = 'pending' | 'ready' | 'needs_media' | 'failed';

export interface AssetRow {
  id: string;
  owner_id: string;
  device_asset_id: string;
  device_id: string;
  type: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'OTHER';
  original_path: string;
  original_file_name: string;
  checksum: string;
  file_created_at: string;
  file_modified_at: string;
  local_date_time: string;
  duration: number | null;
  is_favorite: number;
  visibility: 'archive' | 'timeline' | 'hidden' | 'locked';
  live_photo_video_id: string | null;
  thumbhash: string | null;
  width: number | null;
  height: number | null;
  file_size: number;
  status: AssetStatus;
  error: string | null;
  has_thumbnail: number;
  backed_up_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  update_id: string;
}

export interface ExifRow {
  asset_id: string;
  owner_id: string;
  make: string | null;
  model: string | null;
  lens_model: string | null;
  exposure_time: string | null;
  f_number: number | null;
  focal_length: number | null;
  iso: number | null;
  latitude: number | null;
  longitude: number | null;
  city: string | null;
  state: string | null;
  country: string | null;
  date_time_original: string | null;
  modify_date: string | null;
  time_zone: string | null;
  orientation: string | null;
  rating: number | null;
  description: string | null;
  exif_image_width: number | null;
  exif_image_height: number | null;
  file_size_in_byte: number | null;
  profile_description: string | null;
  projection_type: string | null;
  fps: number | null;
  update_id: string;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/schema.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add migrations src/db/rows.ts test/schema.test.ts
git commit -m "Add D1 schema for users, sessions, assets, exif, audit and sync checkpoints"
```

---

### Task 4: Cursor-bumping writer (`changes`)

**Files:**
- Create: `src/db/changes.ts`
- Test: `test/changes.test.ts`

**Interfaces:**
- Produces:
  - `CURSOR_SQL: string`
  - `formatCursor(n: number): string`
  - `class Tracked { sql: string; binds: unknown[] }`
  - `tracked(sql: string, ...binds: unknown[]): Tracked` (SQL must contain `:cursor`, which becomes the row's cursor)
  - `commit(db: D1Database, items: Array<Tracked | D1PreparedStatement>): Promise<D1Result[]>`
  - `nowCursor(db: D1Database): Promise<string>`

- [ ] **Step 1: Write the failing tests**

`test/changes.test.ts`:

```ts
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { commit, formatCursor, nowCursor, tracked } from '../src/db/changes';

const now = '2026-01-01T00:00:00.000Z';
const insertUser = (id: string, email: string) =>
  tracked(
    'INSERT INTO users (id, email, name, password_hash, profile_changed_at, created_at, updated_at, update_id) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?5, :cursor)',
    id,
    email,
    'N',
    'x',
    now,
  );

describe('changes', () => {
  it('formats cursors as sortable UUID-shaped strings', () => {
    expect(formatCursor(1)).toBe('00000000-0000-7000-8000-000000000001');
    expect(formatCursor(255) > formatCursor(16)).toBe(true);
  });

  it('each tracked row gets its own cursor, in commit order', async () => {
    await commit(env.DB, [insertUser('u1', 'a@x.y'), insertUser('u2', 'b@x.y')]);
    const rows = await env.DB.prepare('SELECT id, update_id FROM users ORDER BY update_id').all<{ id: string; update_id: string }>();
    expect(rows.results).toEqual([
      { id: 'u1', update_id: formatCursor(1) },
      { id: 'u2', update_id: formatCursor(2) },
    ]);
    expect(await nowCursor(env.DB)).toBe(formatCursor(2));
  });

  it('rolls back rows and cursor when any statement fails', async () => {
    await commit(env.DB, [insertUser('u1', 'a@x.y')]);
    await expect(commit(env.DB, [insertUser('u2', 'b@x.y'), insertUser('u3', 'a@x.y')])).rejects.toThrow();
    expect(await env.DB.prepare('SELECT count(*) AS n FROM users').first('n')).toBe(1);
    expect(await nowCursor(env.DB)).toBe(formatCursor(1));
  });

  it('refuses SQL without :cursor', () => {
    expect(() => tracked('UPDATE users SET name = ?1', 'x')).toThrow(/:cursor/);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run test/changes.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/db/changes.ts`:

```ts
const PREFIX = '00000000-0000-7000-8000-';

export const CURSOR_SQL = `(SELECT '${PREFIX}' || printf('%012x', v) FROM seq WHERE id = 1)`;
const BUMP_SQL = 'UPDATE seq SET v = v + 1 WHERE id = 1';

export function formatCursor(n: number): string {
  return PREFIX + n.toString(16).padStart(12, '0');
}

/** A statement that writes exactly one synced row; `:cursor` marks where its update_id goes. */
export class Tracked {
  constructor(readonly sql: string, readonly binds: unknown[]) {}
}

export function tracked(sql: string, ...binds: unknown[]): Tracked {
  if (!sql.includes(':cursor')) throw new Error('tracked SQL must set update_id (or audit id) to :cursor');
  return new Tracked(sql.replaceAll(':cursor', CURSOR_SQL), binds);
}

/**
 * Runs all items in one D1 transaction. Each Tracked item is preceded by a seq bump,
 * so every synced row gets its own cursor and cursor order equals commit order.
 */
export async function commit(db: D1Database, items: Array<Tracked | D1PreparedStatement>): Promise<D1Result[]> {
  const statements: D1PreparedStatement[] = [];
  for (const item of items) {
    if (item instanceof Tracked) {
      statements.push(db.prepare(BUMP_SQL), db.prepare(item.sql).bind(...item.binds));
    } else {
      statements.push(item);
    }
  }
  return db.batch(statements);
}

export async function nowCursor(db: D1Database): Promise<string> {
  const row = await db.prepare(`SELECT ${CURSOR_SQL} AS c`).first<{ c: string }>();
  return row!.c;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/changes.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/db/changes.ts test/changes.test.ts
git commit -m "Add changes writer that gives every synced row its own cursor"
```

---

### Task 5: Auth (passwords, sessions, login, logout, validate, admin sign-up)

**Files:**
- Create: `src/auth/password.ts`, `src/auth/session.ts`, `src/auth/routes.ts`
- Create: `src/users/repo.ts`, `src/users/map.ts`
- Modify: `src/app.ts` (typed `Variables`, mount auth routes)
- Create: `test/helpers.ts`
- Test: `test/auth.test.ts`

**Interfaces:**
- Consumes: `tracked`, `commit` (Task 4); `UserRow`, `SessionRow` (Task 3); `ImmichError` (Task 2).
- Produces:
  - `hashPassword(pw: string): Promise<string>`, `verifyPassword(pw: string, stored: string): Promise<boolean>`
  - `extractToken(req: Request): string | null`
  - `createSession(db, userId, deviceType, deviceOs): Promise<{ token: string; session: SessionRow }>`
  - `findSession(db, token): Promise<AuthContext | null>` where `AuthContext = { user: UserRow; session: SessionRow }`
  - `requireAuth: MiddlewareHandler<AppEnv>` (sets `c.get('auth')`)
  - `insertUser(db, { email, name, password, isAdmin }): Promise<UserRow>`, `getUserById(db, id)`, `countUsers(db)`
  - `mapUserAdmin(u: UserRow): Dto<'UserAdminResponseDto'>`
  - `AppEnv` becomes `{ Bindings: Env; Variables: { auth: AuthContext } }`
  - Test helpers: `createUser(opts?)`, `login(email, password): Promise<string>` (returns access token), `authHeaders(token)`

- [ ] **Step 1: Write the failing tests**

`test/helpers.ts`:

```ts
import { env, SELF } from 'cloudflare:test';
import { insertUser } from '../src/users/repo';

export const BASE = 'https://immich.test';

export async function createUser(opts: { email?: string; password?: string; name?: string; isAdmin?: boolean } = {}) {
  return insertUser(env.DB, {
    email: opts.email ?? 'admin@example.com',
    password: opts.password ?? 'secret-pass-1',
    name: opts.name ?? 'Admin',
    isAdmin: opts.isAdmin ?? true,
  });
}

/** Each call uses a fresh client IP so the login rate limiter (shared across test files) never trips. */
export async function login(email = 'admin@example.com', password = 'secret-pass-1'): Promise<string> {
  const ip = `10.${[0, 0, 0].map(() => Math.floor(Math.random() * 250)).join('.')}`;
  const res = await SELF.fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 201) throw new Error(`login failed ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

export function authHeaders(token: string): Record<string, string> {
  return { 'x-immich-user-token': token };
}
```

`test/auth.test.ts`:

```ts
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/password';
import { extractToken } from '../src/auth/session';
import { expectResponse } from './contract';
import { authHeaders, BASE, createUser, login } from './helpers';

describe('password', () => {
  it('hashes in the versioned format and verifies', async () => {
    const h = await hashPassword('pw-123456');
    expect(h).toMatch(/^pbkdf2-sha256\$100000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(await verifyPassword('pw-123456', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
  });
});

describe('extractToken', () => {
  const req = (headers: Record<string, string>, query = '') => new Request(`${BASE}/api/x${query}`, { headers });
  it('follows Immich order', () => {
    expect(extractToken(req({ 'x-immich-user-token': 'a', authorization: 'Bearer b' }))).toBe('a');
    expect(extractToken(req({ 'x-immich-session-token': 's', cookie: 'immich_access_token=c' }))).toBe('s');
    expect(extractToken(req({ authorization: 'Bearer b', cookie: 'immich_access_token=c' }, '?sessionKey=k'))).toBe('k');
    expect(extractToken(req({ authorization: 'Bearer b', cookie: 'immich_access_token=c' }))).toBe('b');
    expect(extractToken(req({ cookie: 'x=1; immich_access_token=c; y=2' }))).toBe('c');
    expect(extractToken(req({}))).toBeNull();
  });
});

describe('auth routes', () => {
  it('admin sign-up works once, then refuses', async () => {
    const body = JSON.stringify({ email: 'first@example.com', password: 'pw-123456', name: 'First' });
    const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body };
    const res = await SELF.fetch(`${BASE}/api/auth/admin-sign-up`, init);
    expect(res.status).toBe(201);
    const user = await res.json();
    expectResponse('/auth/admin-sign-up', 'post', 201, user);
    expect((user as { isAdmin: boolean }).isAdmin).toBe(true);
    const again = await SELF.fetch(`${BASE}/api/auth/admin-sign-up`, init);
    expect(again.status).toBe(400);
  });

  it('login returns the DTO and sets the three cookies', async () => {
    await createUser();
    const res = await SELF.fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-immich-device-model': 'iPhone', 'cf-connecting-ip': '203.0.113.1' },
      body: JSON.stringify({ email: 'ADMIN@example.com', password: 'secret-pass-1' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expectResponse('/auth/login', 'post', 201, body);
    expect(body.isOnboarded).toBe(true);
    const cookies = res.headers.getSetCookie();
    expect(cookies.find((c) => c.startsWith('immich_access_token='))).toMatch(/HttpOnly/);
    expect(cookies.find((c) => c.startsWith('immich_auth_type=password'))).toMatch(/HttpOnly/);
    const isAuth = cookies.find((c) => c.startsWith('immich_is_authenticated=true'))!;
    expect(isAuth).not.toMatch(/HttpOnly/);
    for (const c of cookies) expect(c).toMatch(/Path=\/.*SameSite=Lax|SameSite=Lax.*Path=\//);
  });

  it('rejects a wrong password with 401', async () => {
    await createUser();
    const res = await SELF.fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.2' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'nope' }),
    });
    expect(res.status).toBe(401);
  });

  it('rate-limits repeated login attempts', async () => {
    await createUser();
    let last = 0;
    for (let i = 0; i < 12; i++) {
      const res = await SELF.fetch(`${BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.3' },
        body: JSON.stringify({ email: 'admin@example.com', password: 'nope' }),
      });
      last = res.status;
    }
    expect(last).toBe(429);
  });

  it('validateToken accepts the token from a cookie and rejects garbage', async () => {
    await createUser();
    const token = await login();
    const ok = await SELF.fetch(`${BASE}/api/auth/validateToken`, { method: 'POST', headers: { cookie: `immich_access_token=${token}` } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ authStatus: true });
    const bad = await SELF.fetch(`${BASE}/api/auth/validateToken`, { method: 'POST', headers: authHeaders('garbage') });
    expect(bad.status).toBe(401);
  });

  it('logout deletes the session and clears cookies', async () => {
    await createUser();
    const token = await login();
    const res = await SELF.fetch(`${BASE}/api/auth/logout`, { method: 'POST', headers: authHeaders(token) });
    expect(res.status).toBe(200);
    expectResponse('/auth/logout', 'post', 200, await res.json());
    expect(res.headers.getSetCookie().some((c) => c.startsWith('immich_access_token=;'))).toBe(true);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM sessions').first('n')).toBe(0);
  });
});
```

The pinned spec declares 200 for `/auth/logout` and `/auth/validateToken`, 201 for `/auth/login` and `/auth/admin-sign-up`.

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run test/auth.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement password hashing**

`src/auth/password.ts`:

```ts
const ITERATIONS = 100_000; // Workers runtime maximum for PBKDF2

const toB64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${ITERATIONS}$${toB64(salt)}$${toB64(await derive(password, salt, ITERATIONS))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, iterations, salt, hash] = stored.split('$');
  if (alg !== 'pbkdf2-sha256' || !salt || !hash) return false;
  const got = await derive(password, fromB64(salt), Number(iterations));
  const want = fromB64(hash);
  return got.length === want.length && crypto.subtle.timingSafeEqual(got, want);
}
```

- [ ] **Step 4: Implement the user repo and mapper**

`src/users/repo.ts`:

```ts
import { hashPassword } from '../auth/password';
import { commit, tracked } from '../db/changes';
import type { UserRow } from '../db/rows';

export async function insertUser(
  db: D1Database,
  input: { email: string; name: string; password: string; isAdmin: boolean },
): Promise<UserRow> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await commit(db, [
    tracked(
      `INSERT INTO users (id, email, name, password_hash, is_admin, profile_changed_at, created_at, updated_at, update_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?6, :cursor)`,
      id,
      input.email.toLowerCase(),
      input.name,
      await hashPassword(input.password),
      input.isAdmin ? 1 : 0,
      now,
    ),
  ]);
  return (await getUserById(db, id))!;
}

export function getUserById(db: D1Database, id: string): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE id = ?1 AND deleted_at IS NULL').bind(id).first<UserRow>();
}

export function getUserByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE email = ?1 AND deleted_at IS NULL').bind(email.toLowerCase()).first<UserRow>();
}

export async function countUsers(db: D1Database): Promise<number> {
  return (await db.prepare('SELECT count(*) AS n FROM users').first<number>('n')) ?? 0;
}
```

`src/users/map.ts`:

```ts
import type { UserRow } from '../db/rows';
import type { Dto } from '../gen/dto';

type AvatarColor = Dto<'UserAvatarColor'>;

export function mapUserAdmin(u: UserRow): Dto<'UserAdminResponseDto'> {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    isAdmin: u.is_admin === 1,
    avatarColor: u.avatar_color as AvatarColor,
    profileImagePath: '',
    profileChangedAt: u.profile_changed_at,
    shouldChangePassword: false,
    storageLabel: u.storage_label,
    quotaSizeInBytes: u.quota_bytes,
    quotaUsageInBytes: u.usage_bytes,
    createdAt: u.created_at,
    updatedAt: u.updated_at,
    deletedAt: u.deleted_at,
    oauthId: '',
    status: 'active',
    license: null,
    clusterGroupId: u.id,
  };
}

export function mapSyncAuthUser(u: UserRow): Dto<'SyncAuthUserV2'> {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    isAdmin: u.is_admin === 1,
    avatarColor: u.avatar_color as AvatarColor,
    deletedAt: u.deleted_at,
    hasProfileImage: false,
    profileChangedAt: u.profile_changed_at,
    oauthId: null,
    pinCode: null,
    quotaSizeInBytes: u.quota_bytes,
    quotaUsageInBytes: u.usage_bytes,
    storageLabel: u.storage_label,
  };
}

export function mapSyncUser(u: UserRow): Dto<'SyncUserV1'> {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    avatarColor: u.avatar_color as AvatarColor,
    deletedAt: u.deleted_at,
    hasProfileImage: false,
    profileChangedAt: u.profile_changed_at,
  };
}
```

If `npm run typecheck` reports a mismatch in these mappers (for example a field the generated type marks differently), fix the mapper to satisfy `src/gen/immich.d.ts`; the generated type is authoritative.

- [ ] **Step 5: Implement sessions and middleware**

`src/auth/session.ts`:

```ts
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../app';
import type { SessionRow, UserRow } from '../db/rows';
import { ImmichError } from '../http/errors';

export interface AuthContext {
  user: UserRow;
  session: SessionRow;
}

const hex = (buf: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(value: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function extractToken(req: Request): string | null {
  const h = req.headers;
  const auth = h.get('authorization');
  const bearer = auth?.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : null;
  return (
    h.get('x-immich-user-token') ??
    h.get('x-immich-session-token') ??
    new URL(req.url).searchParams.get('sessionKey') ??
    bearer ??
    readCookie(h.get('cookie'), 'immich_access_token')
  );
}

export async function createSession(db: D1Database, userId: string, deviceType: string, deviceOs: string) {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const now = new Date().toISOString();
  const session: SessionRow = {
    id: crypto.randomUUID(),
    user_id: userId,
    token_sha256: await sha256Hex(token),
    device_type: deviceType,
    device_os: deviceOs,
    reset_at: null,
    created_at: now,
    updated_at: now,
  };
  await db
    .prepare(
      'INSERT INTO sessions (id, user_id, token_sha256, device_type, device_os, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)',
    )
    .bind(session.id, userId, session.token_sha256, deviceType, deviceOs, now)
    .run();
  return { token, session };
}

export async function findSession(db: D1Database, token: string): Promise<AuthContext | null> {
  const row = await db
    .prepare(
      `SELECT s.id AS s_id, s.user_id, s.token_sha256, s.device_type, s.device_os, s.reset_at, s.created_at AS s_created_at, s.updated_at AS s_updated_at, u.*
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_sha256 = ?1 AND u.deleted_at IS NULL`,
    )
    .bind(await sha256Hex(token))
    .first<Record<string, any>>();
  if (!row) return null;
  const session: SessionRow = {
    id: row.s_id,
    user_id: row.user_id,
    token_sha256: row.token_sha256,
    device_type: row.device_type,
    device_os: row.device_os,
    reset_at: row.reset_at,
    created_at: row.s_created_at,
    updated_at: row.s_updated_at,
  };
  const { s_id, user_id, token_sha256, device_type, device_os, reset_at, s_created_at, s_updated_at, ...user } = row;
  return { session, user: user as UserRow };
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = extractToken(c.req.raw);
  const auth = token ? await findSession(c.env.DB, token) : null;
  if (!auth) throw new ImmichError(401, 'Invalid user token');
  c.set('auth', auth);
  await next();
};
```

- [ ] **Step 6: Implement auth routes and wire them**

`src/auth/routes.ts`:

```ts
import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from '../app';
import { ImmichError } from '../http/errors';
import { mapUserAdmin } from '../users/map';
import { countUsers, getUserByEmail, insertUser } from '../users/repo';
import { verifyPassword } from './password';
import { createSession, requireAuth } from './session';

const MAX_AGE = 400 * 24 * 60 * 60;
const base = { path: '/', sameSite: 'Lax', secure: true, maxAge: MAX_AGE } as const;

export const authRoutes = new Hono<AppEnv>();

authRoutes.post('/auth/admin-sign-up', async (c) => {
  const body = await c.req.json<{ email?: string; password?: string; name?: string }>();
  if (!body.email || !body.password || !body.name) throw new ImmichError(400, 'email, password and name are required');
  if ((await countUsers(c.env.DB)) > 0) throw new ImmichError(400, 'The server already has an admin');
  const user = await insertUser(c.env.DB, { email: body.email, password: body.password, name: body.name, isAdmin: true });
  return c.json(mapUserAdmin(user), 201);
});

authRoutes.post('/auth/login', async (c) => {
  const body = await c.req.json<{ email?: string; password?: string }>();
  if (!body.email || !body.password) throw new ImmichError(400, 'email and password are required');
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  const { success } = await c.env.LOGIN_LIMITER.limit({ key: `${body.email.toLowerCase()}|${ip}` });
  if (!success) throw new ImmichError(429, 'Too many login attempts');
  const user = await getUserByEmail(c.env.DB, body.email);
  if (!user || !(await verifyPassword(body.password, user.password_hash))) {
    throw new ImmichError(401, 'Incorrect email or password');
  }
  const { token } = await createSession(
    c.env.DB,
    user.id,
    c.req.header('x-immich-device-type') ?? c.req.header('devicetype') ?? '',
    c.req.header('x-immich-device-model') ?? c.req.header('devicemodel') ?? '',
  );
  setCookie(c, 'immich_access_token', token, { ...base, httpOnly: true });
  setCookie(c, 'immich_auth_type', 'password', { ...base, httpOnly: true });
  setCookie(c, 'immich_is_authenticated', 'true', { ...base, httpOnly: false });
  return c.json(
    {
      accessToken: token,
      userId: user.id,
      userEmail: user.email,
      name: user.name,
      isAdmin: user.is_admin === 1,
      isOnboarded: user.is_onboarded === 1,
      profileImagePath: '',
      shouldChangePassword: false,
    },
    201,
  );
});

authRoutes.post('/auth/validateToken', requireAuth, (c) => c.json({ authStatus: true }));

authRoutes.post('/auth/logout', requireAuth, async (c) => {
  await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?1').bind(c.get('auth').session.id).run();
  for (const name of ['immich_access_token', 'immich_auth_type', 'immich_is_authenticated']) {
    deleteCookie(c, name, { path: '/', secure: true });
  }
  return c.json({ successful: true, redirectUri: '/auth/login?autoLaunch=0' });
});
```

Replace `src/app.ts`:

```ts
import { Hono } from 'hono';
import { authRoutes } from './auth/routes';
import type { AuthContext } from './auth/session';
import { notFound, onError } from './http/errors';

export type AppEnv = { Bindings: Env; Variables: { auth: AuthContext } };

export const api = new Hono<AppEnv>();
api.get('/server/ping', (c) => c.json({ res: 'pong' }));
api.route('/', authRoutes);

export const app = new Hono<AppEnv>();
app.route('/api', api);
app.onError(onError);
app.notFound(notFound);
```

Hono's `deleteCookie` writes `name=; Max-Age=0; ...`, which the logout test matches with `startsWith('immich_access_token=;')`.

- [ ] **Step 7: Run tests and typecheck**

Run: `npx vitest run test/auth.test.ts && npm run typecheck`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "Add Immich auth: PBKDF2 passwords, sessions, cookies, login rate limit"
```

---

### Task 6: Server discovery and user endpoints

**Files:**
- Create: `src/server/routes.ts`, `src/users/routes.ts`, `src/defaults/user-preferences.json`, `src/upload/media-types.ts`
- Modify: `src/app.ts`
- Test: `test/server.test.ts`

**Interfaces:**
- Consumes: `requireAuth`, `mapUserAdmin`, `countUsers`.
- Produces:
  - `MEDIA_TYPES: { image: string[]; video: string[]; sidecar: string[] }`
  - `assetTypeFor(filename: string): 'IMAGE' | 'VIDEO' | null`
  - `extensionOf(filename: string): string` (lowercase, with dot, `''` if none)
  - `contentTypeFor(ext: string): string`

- [ ] **Step 1: Copy default preferences**

```bash
mkdir -p src/defaults
cp test/fixtures/immich-3.3.0/user-preferences.json src/defaults/user-preferences.json
```

- [ ] **Step 2: Write the failing tests**

`test/server.test.ts`:

```ts
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { assetTypeFor, extensionOf } from '../src/upload/media-types';
import { expectResponse } from './contract';
import { authHeaders, BASE, createUser, login } from './helpers';

const get = (path: string, headers: Record<string, string> = {}) => SELF.fetch(`${BASE}${path}`, { headers });

describe('server endpoints', () => {
  it('serves .well-known/immich', async () => {
    expect(await (await get('/.well-known/immich')).json()).toEqual({ api: { endpoint: '/api' } });
  });

  it('reports version 3.3.0', async () => {
    const body = await (await get('/api/server/version')).json();
    expectResponse('/server/version', 'get', 200, body);
    expect(body).toEqual({ major: 3, minor: 3, patch: 0, prerelease: null });
  });

  it('features and config match the contract', async () => {
    const features = (await (await get('/api/server/features')).json()) as Record<string, boolean>;
    expectResponse('/server/features', 'get', 200, features);
    expect(features.passwordLogin).toBe(true);
    expect(features.smartSearch).toBe(false);
    const config = (await (await get('/api/server/config')).json()) as Record<string, unknown>;
    expectResponse('/server/config', 'get', 200, config);
    expect(config.isInitialized).toBe(false);
    expect(config.isOnboarded).toBe(true);
    await createUser();
    expect(((await (await get('/api/server/config')).json()) as Record<string, unknown>).isInitialized).toBe(true);
  });

  it('about, version-history, media-types, storage match the contract', async () => {
    await createUser();
    const token = await login();
    expectResponse('/server/about', 'get', 200, await (await get('/api/server/about', authHeaders(token))).json());
    expect(await (await get('/api/server/version-history', authHeaders(token))).json()).toEqual([]);
    const media = await (await get('/api/server/media-types')).json();
    expectResponse('/server/media-types', 'get', 200, media);
    expect((media as { image: string[] }).image).toContain('.heic');
    expectResponse('/server/storage', 'get', 200, await (await get('/api/server/storage', authHeaders(token))).json());
  });

  it('users/me and preferences match the contract', async () => {
    await createUser();
    const token = await login();
    const me = await get('/api/users/me', authHeaders(token));
    expect(me.status).toBe(200);
    expectResponse('/users/me', 'get', 200, await me.json());
    const prefs = await get('/api/users/me/preferences', authHeaders(token));
    expectResponse('/users/me/preferences', 'get', 200, await prefs.json());
  });

  it('users/me requires auth', async () => {
    expect((await get('/api/users/me')).status).toBe(401);
  });
});

describe('media types', () => {
  it('classifies by extension', () => {
    expect(extensionOf('IMG_0001.HEIC')).toBe('.heic');
    expect(assetTypeFor('IMG_0001.HEIC')).toBe('IMAGE');
    expect(assetTypeFor('clip.MOV')).toBe('VIDEO');
    expect(assetTypeFor('notes.txt')).toBeNull();
  });
});
```

- [ ] **Step 3: Run to see it fail**

Run: `npx vitest run test/server.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement media types**

`src/upload/media-types.ts` (lists copied from Immich `server/src/utils/mime-types.ts` at the pinned commit):

```ts
const IMAGE: Record<string, string> = {
  '.3fr': 'image/x-hasselblad-3fr', '.ari': 'image/x-arriflex-ari', '.arw': 'image/x-sony-arw', '.cap': 'image/x-phaseone-cap',
  '.cin': 'image/x-phantom-cin', '.cr2': 'image/x-canon-cr2', '.cr3': 'image/x-canon-cr3', '.crw': 'image/x-canon-crw',
  '.dcr': 'image/x-kodak-dcr', '.dng': 'image/x-adobe-dng', '.erf': 'image/x-epson-erf', '.fff': 'image/x-hasselblad-fff',
  '.iiq': 'image/x-phaseone-iiq', '.k25': 'image/x-kodak-k25', '.kdc': 'image/x-kodak-kdc', '.mrw': 'image/x-minolta-mrw',
  '.nef': 'image/x-nikon-nef', '.nrw': 'image/x-nikon-nrw', '.orf': 'image/x-olympus-orf', '.ori': 'image/x-olympus-ori',
  '.pef': 'image/x-pentax-pef', '.psd': 'image/vnd.adobe.photoshop', '.raf': 'image/x-fuji-raf', '.raw': 'image/x-panasonic-raw',
  '.rw2': 'image/x-panasonic-rw2', '.rwl': 'image/x-leica-rwl', '.sr2': 'image/x-sony-sr2', '.srf': 'image/x-sony-srf',
  '.srw': 'image/x-samsung-srw', '.x3f': 'image/x-sigma-x3f',
  '.avif': 'image/avif', '.bmp': 'image/bmp', '.gif': 'image/gif', '.jfif': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.heic': 'image/heic', '.heif': 'image/heif',
  '.hif': 'image/hif', '.insp': 'image/jpeg', '.jp2': 'image/jp2', '.jpe': 'image/jpeg', '.jxl': 'image/jxl',
  '.mpo': 'image/jpeg', '.svg': 'image/svg', '.tif': 'image/tiff', '.tiff': 'image/tiff',
};

const VIDEO: Record<string, string> = {
  '.3gp': 'video/3gpp', '.3gpp': 'video/3gpp', '.avi': 'video/x-msvideo', '.flv': 'video/x-flv', '.insv': 'video/mp4',
  '.m2t': 'video/mp2t', '.m2ts': 'video/mp2t', '.m4v': 'video/x-m4v', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime',
  '.mp4': 'video/mp4', '.mpe': 'video/mpeg', '.mpeg': 'video/mpeg', '.mpg': 'video/mpeg', '.mts': 'video/mp2t',
  '.mxf': 'application/mxf', '.ts': 'video/mp2t', '.vob': 'video/mpeg', '.webm': 'video/webm', '.wmv': 'video/x-ms-wmv',
};

export const MEDIA_TYPES = { image: Object.keys(IMAGE), video: Object.keys(VIDEO), sidecar: ['.xmp'] };

export function extensionOf(filename: string): string {
  const i = filename.lastIndexOf('.');
  return i < 0 ? '' : filename.slice(i).toLowerCase();
}

export function assetTypeFor(filename: string): 'IMAGE' | 'VIDEO' | null {
  const ext = extensionOf(filename);
  if (ext in IMAGE) return 'IMAGE';
  if (ext in VIDEO) return 'VIDEO';
  return null;
}

export function contentTypeFor(ext: string): string {
  return IMAGE[ext] ?? VIDEO[ext] ?? 'application/octet-stream';
}
```

- [ ] **Step 5: Implement server and user routes**

`src/server/routes.ts`:

```ts
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { requireAuth } from '../auth/session';
import { MEDIA_TYPES } from '../upload/media-types';
import { countUsers } from '../users/repo';

export const serverRoutes = new Hono<AppEnv>();

function version(env: Env) {
  const [major, minor, patch] = env.SERVER_VERSION.split('.').map(Number);
  return { major, minor, patch, prerelease: null };
}

serverRoutes.get('/server/version', (c) => c.json(version(c.env)));
serverRoutes.get('/server/version-history', requireAuth, (c) => c.json([]));
serverRoutes.get('/server/media-types', (c) => c.json(MEDIA_TYPES));

serverRoutes.get('/server/features', (c) =>
  c.json({
    configFile: false, duplicateDetection: false, email: false, facialRecognition: false, importFaces: false, map: false,
    oauth: false, oauthAutoLaunch: false, ocr: false, passwordLogin: true, realtimeTranscoding: false,
    reverseGeocoding: false, search: false, sidecar: false, smartSearch: false, trash: false,
  }),
);

serverRoutes.get('/server/config', async (c) =>
  c.json({
    externalDomain: '', isInitialized: (await countUsers(c.env.DB)) > 0, isOnboarded: true, loginPageMessage: '',
    maintenanceMode: false, mapDarkStyleUrl: '', mapLightStyleUrl: '', minFaces: 3, oauthButtonText: 'Login with OAuth',
    publicUsers: true, trashDays: 30, userDeleteDelay: 7,
  }),
);

serverRoutes.get('/server/about', requireAuth, (c) =>
  c.json({
    version: `v${c.env.SERVER_VERSION}`,
    versionUrl: `https://github.com/immich-app/immich/releases/tag/v${c.env.SERVER_VERSION}`,
    licensed: false,
  }),
);

serverRoutes.get('/server/storage', requireAuth, async (c) => {
  const used = (await c.env.DB.prepare('SELECT coalesce(sum(file_size), 0) AS n FROM assets').first<number>('n')) ?? 0;
  const size = 1024 ** 4; // nominal 1 TiB; R2 has no fixed capacity
  const fmt = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GiB`;
  return c.json({
    diskSize: fmt(size), diskSizeRaw: size, diskUse: fmt(used), diskUseRaw: used,
    diskAvailable: fmt(size - used), diskAvailableRaw: size - used,
    diskUsagePercentage: Math.round((used / size) * 10000) / 100,
  });
});
```

`src/users/routes.ts`:

```ts
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { requireAuth } from '../auth/session';
import defaults from '../defaults/user-preferences.json';
import { mapUserAdmin } from './map';

export const userRoutes = new Hono<AppEnv>();

function merge(base: any, over: any): any {
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return over ?? base;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) out[k] = merge(base[k], v);
  return out;
}

userRoutes.get('/users/me', requireAuth, (c) => c.json(mapUserAdmin(c.get('auth').user)));
userRoutes.get('/users/me/preferences', requireAuth, (c) =>
  c.json(merge(defaults, JSON.parse(c.get('auth').user.preferences || '{}'))),
);
```

Modify `src/app.ts`: import `serverRoutes` and `userRoutes`, add `api.route('/', serverRoutes); api.route('/', userRoutes);` after the auth routes, and add before `app.route('/api', api)`:

```ts
app.get('/.well-known/immich', (c) => c.json({ api: { endpoint: '/api' } }));
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run test/server.test.ts && npm run typecheck`
Expected: all pass. If `/server/about` fails the contract because a field became required, add it with an empty string.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Add server discovery, config, features, media types, users/me and preferences"
```

---

### Task 7: Streaming multipart parser and R2 writer

**Files:**
- Create: `src/upload/multipart.ts`, `src/upload/r2-writer.ts`
- Test: `test/multipart.test.ts`, `test/r2-writer.test.ts`

**Interfaces:**
- Produces:
  - `class MultipartError extends Error`
  - `boundaryOf(contentType: string | null): string` (throws `MultipartError`)
  - `parseMultipart(body: ReadableStream<Uint8Array>, boundary: string, handlers: { field(name: string, value: string): void; file(part: FilePart): Promise<void> }): Promise<void>`
  - `interface FilePart { name: string; filename: string; contentType: string; stream: ReadableStream<Uint8Array> }`
  - `writeToR2(bucket: R2Bucket, key: string, stream: ReadableStream<Uint8Array>, opts: { contentType: string; partSize?: number }): Promise<{ size: number; sha1: Uint8Array }>` (aborts the multipart upload and rethrows on error)
  - `toBase64(u: Uint8Array): string`

- [ ] **Step 1: Write the failing tests**

`test/multipart.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { MultipartError, parseMultipart } from '../src/upload/multipart';

const enc = new TextEncoder();

function body(parts: Array<{ name: string; value?: string; filename?: string; data?: Uint8Array }>, boundary: string) {
  const chunks: Uint8Array[] = [enc.encode('preamble ignored\r\n')];
  for (const p of parts) {
    const disp = p.filename ? `form-data; name="${p.name}"; filename="${p.filename}"` : `form-data; name="${p.name}"`;
    chunks.push(enc.encode(`--${boundary}\r\nContent-Disposition: ${disp}\r\n`));
    if (p.filename) chunks.push(enc.encode('Content-Type: application/octet-stream\r\n'));
    chunks.push(enc.encode('\r\n'), p.data ?? enc.encode(p.value ?? ''), enc.encode('\r\n'));
  }
  chunks.push(enc.encode(`--${boundary}--\r\n`));
  const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  return all;
}

/** Splits bytes into a stream of `size`-byte chunks so boundaries straddle chunk edges. */
function streamOf(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
  let o = 0;
  return new ReadableStream({
    pull(c) {
      if (o >= bytes.length) return c.close();
      c.enqueue(bytes.slice(o, o + size));
      o += size;
    },
  });
}

async function collect(s: ReadableStream<Uint8Array>) {
  return new Uint8Array(await new Response(s).arrayBuffer());
}

describe('parseMultipart', () => {
  const file = new Uint8Array(70_000).map((_, i) => (i * 31) % 256);
  // file content that contains a near-boundary to make sure partial matches are handled
  file.set(enc.encode('\r\n--XBOUNDAR'), 30_000);

  for (const chunk of [1, 7, 4096, 1 << 20]) {
    it(`parses fields before and after the file with ${chunk}-byte chunks`, async () => {
      const bytes = body(
        [
          { name: 'deviceAssetId', value: 'abc' },
          { name: 'assetData', filename: 'IMG_1.HEIC', data: file },
          { name: 'visibility', value: 'hidden' },
        ],
        'XBOUNDARY',
      );
      const fields: Record<string, string> = {};
      let got: Uint8Array | undefined;
      let filename = '';
      await parseMultipart(streamOf(bytes, chunk), 'XBOUNDARY', {
        field: (n, v) => { fields[n] = v; },
        file: async (p) => { filename = p.filename; got = await collect(p.stream); },
      });
      expect(fields).toEqual({ deviceAssetId: 'abc', visibility: 'hidden' });
      expect(filename).toBe('IMG_1.HEIC');
      expect(got).toEqual(file);
    });
  }

  it('throws on a truncated body', async () => {
    const bytes = body([{ name: 'assetData', filename: 'a.jpg', data: file }], 'XBOUNDARY').slice(0, 50_000);
    await expect(
      parseMultipart(streamOf(bytes, 4096), 'XBOUNDARY', { field: () => {}, file: async (p) => { await collect(p.stream); } }),
    ).rejects.toBeInstanceOf(MultipartError);
  });
});
```

`test/r2-writer.test.ts`:

```ts
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { toBase64, writeToR2 } from '../src/upload/r2-writer';

function streamOf(bytes: Uint8Array, size = 65536, failAt?: number): ReadableStream<Uint8Array> {
  let o = 0;
  return new ReadableStream({
    pull(c) {
      if (failAt !== undefined && o >= failAt) return c.error(new Error('client went away'));
      if (o >= bytes.length) return c.close();
      c.enqueue(bytes.slice(o, o + size));
      o += size;
    },
  });
}

async function sha1(bytes: Uint8Array) {
  return toBase64(new Uint8Array(await crypto.subtle.digest('SHA-1', bytes)));
}

describe('writeToR2', () => {
  it('writes a small file with put and returns size and SHA-1', async () => {
    const data = crypto.getRandomValues(new Uint8Array(1000));
    const r = await writeToR2(env.MEDIA, 'k/small', streamOf(data), { contentType: 'image/jpeg' });
    expect(r.size).toBe(1000);
    expect(toBase64(r.sha1)).toBe(await sha1(data));
    expect(new Uint8Array(await (await env.MEDIA.get('k/small'))!.arrayBuffer())).toEqual(data);
  });

  it('writes a multi-part file with equal parts and a short last part', async () => {
    const data = new Uint8Array(5 * 1024 * 1024 * 2 + 12345).map((_, i) => i % 251);
    const r = await writeToR2(env.MEDIA, 'k/big', streamOf(data), { contentType: 'video/quicktime', partSize: 5 * 1024 * 1024 });
    expect(r.size).toBe(data.length);
    expect(toBase64(r.sha1)).toBe(await sha1(data));
    const obj = await env.MEDIA.get('k/big');
    expect(obj!.size).toBe(data.length);
    expect(obj!.httpMetadata?.contentType).toBe('video/quicktime');
  });

  it('aborts and leaves no object when the stream errors', async () => {
    const data = new Uint8Array(12 * 1024 * 1024);
    await expect(
      writeToR2(env.MEDIA, 'k/broken', streamOf(data, 65536, 6 * 1024 * 1024), { contentType: 'video/mp4', partSize: 5 * 1024 * 1024 }),
    ).rejects.toThrow('client went away');
    expect(await env.MEDIA.head('k/broken')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run test/multipart.test.ts test/r2-writer.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement the parser**

`src/upload/multipart.ts`:

```ts
export class MultipartError extends Error {}

export interface FilePart {
  name: string;
  filename: string;
  contentType: string;
  stream: ReadableStream<Uint8Array>;
}

export interface MultipartHandlers {
  field(name: string, value: string): void;
  file(part: FilePart): Promise<void>;
}

const enc = new TextEncoder();
const CRLF = enc.encode('\r\n');
const HEADER_END = enc.encode('\r\n\r\n');
const MAX_HEADER = 16 * 1024;
const MAX_FIELD = 1024 * 1024;

export function boundaryOf(contentType: string | null): string {
  const m = contentType?.match(/^multipart\/form-data;.*boundary=(?:"([^"]+)"|([^;\s]+))/i);
  const b = m?.[1] ?? m?.[2];
  if (!b) throw new MultipartError('expected multipart/form-data with a boundary');
  return b;
}

function find(haystack: Uint8Array, needle: Uint8Array): number {
  const first = needle[0];
  let i = haystack.indexOf(first);
  while (i !== -1 && i <= haystack.length - needle.length) {
    let j = 1;
    while (j < needle.length && haystack[i + j] === needle[j]) j++;
    if (j === needle.length) return i;
    i = haystack.indexOf(first, i + 1);
  }
  return -1;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

class Reader {
  private buf = new Uint8Array(0);
  private ended = false;
  constructor(private readonly source: ReadableStreamDefaultReader<Uint8Array>) {}

  private async pull(): Promise<boolean> {
    if (this.ended) return false;
    const { value, done } = await this.source.read();
    if (done) {
      this.ended = true;
      return false;
    }
    this.buf = concat(this.buf, value);
    return true;
  }

  /** Yields bytes up to `delim`, then consumes `delim`. Throws if the body ends first. */
  async *until(delim: Uint8Array, limit = Infinity): AsyncGenerator<Uint8Array> {
    let emitted = 0;
    for (;;) {
      const i = find(this.buf, delim);
      if (i >= 0) {
        if (i > 0) yield this.buf.subarray(0, i);
        this.buf = this.buf.subarray(i + delim.length);
        return;
      }
      const keep = delim.length - 1;
      if (this.buf.length > keep) {
        const out = this.buf.subarray(0, this.buf.length - keep);
        emitted += out.length;
        if (emitted > limit) throw new MultipartError('part too large');
        yield out;
        this.buf = this.buf.slice(this.buf.length - keep);
      }
      if (!(await this.pull())) throw new MultipartError('unexpected end of multipart body');
    }
  }

  async take(n: number): Promise<Uint8Array> {
    while (this.buf.length < n) if (!(await this.pull())) throw new MultipartError('unexpected end of multipart body');
    const out = this.buf.slice(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
}

async function readText(gen: AsyncGenerator<Uint8Array>): Promise<string> {
  const dec = new TextDecoder();
  let s = '';
  for await (const chunk of gen) s += dec.decode(chunk, { stream: true });
  return s + dec.decode();
}

function parseHeaders(raw: string): { name: string; filename?: string; contentType: string } {
  let name: string | undefined;
  let filename: string | undefined;
  let contentType = 'application/octet-stream';
  for (const line of raw.split('\r\n')) {
    const sep = line.indexOf(':');
    if (sep < 0) continue;
    const key = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();
    if (key === 'content-type') contentType = value;
    if (key === 'content-disposition') {
      name = value.match(/(?:^|;)\s*name="([^"]*)"/i)?.[1];
      const star = value.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
      filename = star ? decodeURIComponent(star) : value.match(/(?:^|;)\s*filename="([^"]*)"/i)?.[1];
    }
  }
  if (name === undefined) throw new MultipartError('part without a name');
  return { name, filename, contentType };
}

/** Prepends CRLF so the first boundary matches the same "\r\n--boundary" delimiter as later ones. */
function withLeadingCrlf(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let started = false;
  return new ReadableStream({
    async pull(c) {
      if (!started) {
        started = true;
        c.enqueue(CRLF);
        return;
      }
      const { value, done } = await reader.read();
      if (done) c.close();
      else c.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

export async function parseMultipart(body: ReadableStream<Uint8Array>, boundary: string, handlers: MultipartHandlers): Promise<void> {
  const reader = new Reader(withLeadingCrlf(body).getReader());
  const delim = enc.encode(`\r\n--${boundary}`);
  for await (const _ of reader.until(delim)) {
    // preamble is discarded
  }
  for (;;) {
    const next = await reader.take(2);
    if (next[0] === 0x2d && next[1] === 0x2d) return; // "--" closes the body
    if (next[0] !== 0x0d || next[1] !== 0x0a) throw new MultipartError('malformed boundary line');
    const headers = parseHeaders(await readText(reader.until(HEADER_END, MAX_HEADER)));
    if (headers.filename === undefined) {
      handlers.field(headers.name, await readText(reader.until(delim, MAX_FIELD)));
      continue;
    }
    const content = reader.until(delim);
    const stream = new ReadableStream<Uint8Array>({
      async pull(c) {
        try {
          const r = await content.next();
          if (r.done) c.close();
          else c.enqueue(r.value.slice());
        } catch (e) {
          c.error(e);
        }
      },
    });
    await handlers.file({ name: headers.name, filename: headers.filename, contentType: headers.contentType, stream });
    for await (const _ of content) {
      // drain whatever the handler did not read
    }
  }
}
```

- [ ] **Step 4: Implement the R2 writer**

`src/upload/r2-writer.ts`:

```ts
const DEFAULT_PART = 10 * 1024 * 1024;

export function toBase64(u: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * Streams `stream` into R2 at `key`, hashing with SHA-1 on the way.
 * Files that fit in one part use put(); larger files use a multipart upload with equal-size parts.
 * On any error the multipart upload is aborted and the error rethrown.
 */
export async function writeToR2(
  bucket: R2Bucket,
  key: string,
  stream: ReadableStream<Uint8Array>,
  opts: { contentType: string; partSize?: number },
): Promise<{ size: number; sha1: Uint8Array }> {
  const partSize = opts.partSize ?? DEFAULT_PART;
  const digest = new crypto.DigestStream('SHA-1');
  const hasher = digest.getWriter();
  let upload: R2MultipartUpload | undefined;
  const parts: R2UploadedPart[] = [];
  let part = new Uint8Array(partSize);
  let filled = 0;
  let size = 0;

  const flush = async () => {
    upload ??= await bucket.createMultipartUpload(key, { httpMetadata: { contentType: opts.contentType } });
    parts.push(await upload.uploadPart(parts.length + 1, part.subarray(0, filled)));
    part = new Uint8Array(partSize);
    filled = 0;
  };

  try {
    const reader = stream.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      await hasher.write(value);
      size += value.length;
      let offset = 0;
      while (offset < value.length) {
        const n = Math.min(partSize - filled, value.length - offset);
        part.set(value.subarray(offset, offset + n), filled);
        filled += n;
        offset += n;
        if (filled === partSize) await flush();
      }
    }
    await hasher.close();
    if (!upload) {
      await bucket.put(key, part.subarray(0, filled), { httpMetadata: { contentType: opts.contentType } });
    } else {
      if (filled > 0) await flush();
      await upload.complete(parts);
    }
    return { size, sha1: new Uint8Array(await digest.digest) };
  } catch (err) {
    await upload?.abort().catch(() => {});
    throw err;
  }
}
```

A file of exactly `partSize` bytes goes through `flush()` once with zero bytes left, then `complete()` with one part; that is valid.

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/multipart.test.ts test/r2-writer.test.ts && npm run typecheck`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/upload/multipart.ts src/upload/r2-writer.ts test/multipart.test.ts test/r2-writer.test.ts
git commit -m "Add streaming multipart parser and SHA-1 hashing R2 writer"
```

---

### Task 8: Upload endpoint and bulk upload check

**Files:**
- Create: `src/upload/routes.ts`
- Modify: `src/app.ts`, `test/helpers.ts`
- Test: `test/upload.test.ts`

**Interfaces:**
- Consumes: `parseMultipart`, `boundaryOf`, `writeToR2`, `toBase64`, `assetTypeFor`, `extensionOf`, `contentTypeFor`, `tracked`, `commit`, `requireAuth`.
- Produces:
  - `POST /api/assets` → `201 {id, status: 'created'}` or `200 {id, status: 'duplicate'}`
  - `POST /api/assets/bulk-upload-check`
  - Queue message type `ProcessMessage = { assetId: string }` exported from `src/upload/routes.ts`
  - `originalKey(ownerId: string, assetId: string, ext: string): string`
  - Test helper `uploadAsset(token, bytes, opts?)` returning the parsed JSON and status

- [ ] **Step 1: Add the test helper**

Append to `test/helpers.ts`:

```ts
export async function uploadAsset(
  token: string,
  bytes: Uint8Array,
  opts: { filename?: string; fields?: Record<string, string>; fieldsAfterFile?: Record<string, string> } = {},
) {
  const form = new FormData();
  const fields = {
    deviceAssetId: opts.filename ?? 'IMG_0001.JPG',
    deviceId: 'test-device',
    fileCreatedAt: '2024-05-04T10:00:00.000Z',
    fileModifiedAt: '2024-05-04T10:00:00.000Z',
    isFavorite: 'false',
    duration: '0',
    ...opts.fields,
  };
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append('assetData', new File([bytes], opts.filename ?? 'IMG_0001.JPG', { type: 'application/octet-stream' }));
  for (const [k, v] of Object.entries(opts.fieldsAfterFile ?? {})) form.append(k, v);
  const res = await SELF.fetch(`${BASE}/api/assets`, { method: 'POST', headers: authHeaders(token), body: form });
  return { status: res.status, body: (await res.json()) as { id: string; status: string } };
}
```

- [ ] **Step 2: Write the failing tests**

`test/upload.test.ts`:

```ts
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { expectResponse } from './contract';
import { authHeaders, BASE, createUser, login, uploadAsset } from './helpers';

const jpeg = () => crypto.getRandomValues(new Uint8Array(4096));

async function setup() {
  await createUser();
  return login();
}

describe('POST /assets', () => {
  it('stores the original, inserts a pending asset, and enqueues processing', async () => {
    const token = await setup();
    const bytes = jpeg();
    const { status, body } = await uploadAsset(token, bytes);
    expect(status).toBe(201);
    expectResponse('/assets', 'post', 201, body);
    const row = await env.DB.prepare('SELECT * FROM assets WHERE id = ?1').bind(body.id).first<any>();
    expect(row.status).toBe('pending');
    expect(row.type).toBe('IMAGE');
    expect(row.original_file_name).toBe('IMG_0001.JPG');
    expect(row.file_size).toBe(4096);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes));
    expect(row.checksum).toBe(btoa(String.fromCharCode(...digest)));
    expect(await env.MEDIA.head(row.original_path)).not.toBeNull();
  });

  it('duplicate upload deletes the new object and returns the existing id', async () => {
    const token = await setup();
    const bytes = jpeg();
    const first = await uploadAsset(token, bytes);
    const second = await uploadAsset(token, bytes, { filename: 'copy.jpg' });
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ id: first.body.id, status: 'duplicate' });
    const listed = await env.MEDIA.list({ prefix: 'originals/' });
    expect(listed.objects).toHaveLength(1);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM assets').first('n')).toBe(1);
  });

  it('answers duplicates from x-immich-checksum without reading the body', async () => {
    const token = await setup();
    const bytes = jpeg();
    const first = await uploadAsset(token, bytes);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes));
    const res = await SELF.fetch(`${BASE}/api/assets`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'x-immich-checksum': btoa(String.fromCharCode(...digest)), 'content-type': 'multipart/form-data; boundary=x' },
      body: 'not a valid body',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: first.body.id, status: 'duplicate' });
  });

  it('accepts fields after the file and fills defaults for missing device fields', async () => {
    const token = await setup();
    const form = new FormData();
    form.append('fileCreatedAt', '2024-05-04T10:00:00.000Z');
    form.append('fileModifiedAt', '2024-05-04T10:00:00.000Z');
    form.append('assetData', new File([jpeg()], 'web.png'));
    form.append('visibility', 'hidden');
    const res = await SELF.fetch(`${BASE}/api/assets`, { method: 'POST', headers: authHeaders(token), body: form });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const row = await env.DB.prepare('SELECT visibility, device_id, device_asset_id FROM assets WHERE id = ?1').bind(id).first<any>();
    expect(row.visibility).toBe('hidden');
    expect(row.device_id).toBe('WEB');
    expect(row.device_asset_id).toMatch(/^web-/);
  });

  it('rejects unsupported file types with 400', async () => {
    const token = await setup();
    const { status } = await uploadAsset(token, jpeg(), { filename: 'notes.txt' });
    expect(status).toBe(400);
    expect((await env.MEDIA.list({ prefix: 'originals/' })).objects).toHaveLength(0);
  });

  it('truncated body aborts and inserts nothing', async () => {
    const token = await setup();
    const boundary = 'BOUNDARY123';
    const head = `--${boundary}\r\nContent-Disposition: form-data; name="fileCreatedAt"\r\n\r\n2024-05-04T10:00:00.000Z\r\n--${boundary}\r\nContent-Disposition: form-data; name="fileModifiedAt"\r\n\r\n2024-05-04T10:00:00.000Z\r\n--${boundary}\r\nContent-Disposition: form-data; name="assetData"; filename="a.jpg"\r\n\r\n`;
    const res = await SELF.fetch(`${BASE}/api/assets`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': `multipart/form-data; boundary=${boundary}` },
      body: head + 'x'.repeat(5000),
    });
    expect(res.status).toBe(400);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM assets').first('n')).toBe(0);
    expect((await env.MEDIA.list({ prefix: 'originals/' })).objects).toHaveLength(0);
  });

  it('rejects uploads over quota', async () => {
    const token = await setup();
    await env.DB.prepare('UPDATE users SET quota_bytes = 100').run();
    const { status } = await uploadAsset(token, jpeg());
    expect(status).toBe(400);
  });
});

describe('POST /assets/bulk-upload-check', () => {
  it('rejects known checksums and accepts new ones', async () => {
    const token = await setup();
    const bytes = jpeg();
    const { body } = await uploadAsset(token, bytes);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes));
    const hex = [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
    const res = await SELF.fetch(`${BASE}/api/assets/bulk-upload-check`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ assets: [{ id: 'one', checksum: hex }, { id: 'two', checksum: 'ab'.repeat(20) }] }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expectResponse('/assets/bulk-upload-check', 'post', 200, json);
    expect(json).toEqual({
      results: [
        { id: 'one', action: 'reject', reason: 'duplicate', assetId: body.id, isTrashed: false },
        { id: 'two', action: 'accept' },
      ],
    });
  });
});
```

Queue messages sent from `SELF.fetch` in tests go to the in-process consumer only once Task 10 adds a `queue` handler; until then Miniflare keeps them queued, which does not affect these assertions.

- [ ] **Step 3: Run to see them fail**

Run: `npx vitest run test/upload.test.ts`
Expected: FAIL (404s).

- [ ] **Step 4: Implement**

`src/upload/routes.ts`:

```ts
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { requireAuth } from '../auth/session';
import { commit, tracked } from '../db/changes';
import { ImmichError } from '../http/errors';
import { assetTypeFor, contentTypeFor, extensionOf } from './media-types';
import { boundaryOf, MultipartError, parseMultipart } from './multipart';
import { toBase64, writeToR2 } from './r2-writer';

export interface ProcessMessage {
  assetId: string;
}

export const uploadRoutes = new Hono<AppEnv>();

export function originalKey(ownerId: string, assetId: string, ext: string): string {
  return `originals/${ownerId}/${assetId}${ext}`;
}

/** Accepts base64 or hex SHA-1 and returns base64. */
function normaliseChecksum(value: string): string {
  if (/^[0-9a-f]{40}$/i.test(value)) {
    const bytes = new Uint8Array(20);
    for (let i = 0; i < 20; i++) bytes[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
    return toBase64(bytes);
  }
  return value;
}

async function findByChecksum(db: D1Database, ownerId: string, checksum: string) {
  return db
    .prepare('SELECT id, deleted_at FROM assets WHERE owner_id = ?1 AND checksum = ?2')
    .bind(ownerId, checksum)
    .first<{ id: string; deleted_at: string | null }>();
}

uploadRoutes.post('/assets', requireAuth, async (c) => {
  const { user } = c.get('auth');
  const db = c.env.DB;

  const headerSum = c.req.header('x-immich-checksum');
  if (headerSum) {
    const existing = await findByChecksum(db, user.id, normaliseChecksum(headerSum));
    if (existing) return c.json({ id: existing.id, status: 'duplicate' }, 200);
  }

  const length = Number(c.req.header('content-length') ?? 0);
  if (user.quota_bytes !== null && user.usage_bytes + length > user.quota_bytes) {
    throw new ImmichError(400, 'Quota has been exceeded!');
  }
  if (!c.req.raw.body) throw new ImmichError(400, 'Missing body');

  const assetId = crypto.randomUUID();
  const fields: Record<string, string> = {};
  let file: { filename: string; key: string; size: number; checksum: string; type: 'IMAGE' | 'VIDEO' } | undefined;

  try {
    await parseMultipart(c.req.raw.body, boundaryOf(c.req.header('content-type') ?? null), {
      field: (name, value) => {
        fields[name] = value;
      },
      file: async (part) => {
        if (part.name !== 'assetData') return; // sidecarData and others are ignored in phase 1
        const type = assetTypeFor(part.filename);
        if (!type) throw new ImmichError(400, `Unsupported file type ${part.filename}`);
        const ext = extensionOf(part.filename);
        const key = originalKey(user.id, assetId, ext);
        const { size, sha1 } = await writeToR2(c.env.MEDIA, key, part.stream, { contentType: contentTypeFor(ext) });
        file = { filename: part.filename, key, size, checksum: toBase64(sha1), type };
      },
    });
  } catch (err) {
    if (file) await c.env.MEDIA.delete(file.key);
    if (err instanceof MultipartError) throw new ImmichError(400, err.message);
    throw err;
  }

  if (!file) throw new ImmichError(400, 'assetData is required');
  if (user.quota_bytes !== null && user.usage_bytes + file.size > user.quota_bytes) {
    await c.env.MEDIA.delete(file.key); // Content-Length can be absent (chunked bodies), so check the real size too
    throw new ImmichError(400, 'Quota has been exceeded!');
  }
  if (!fields.fileCreatedAt || !fields.fileModifiedAt) {
    await c.env.MEDIA.delete(file.key);
    throw new ImmichError(400, 'fileCreatedAt and fileModifiedAt are required');
  }

  const now = new Date().toISOString();
  const createdAt = new Date(fields.fileCreatedAt).toISOString();
  const duration = fields.duration ? parseDuration(fields.duration) : null;
  try {
    await commit(db, [
      tracked(
        `INSERT INTO assets (id, owner_id, device_asset_id, device_id, type, original_path, original_file_name, checksum,
           file_created_at, file_modified_at, local_date_time, duration, is_favorite, visibility, live_photo_video_id,
           file_size, created_at, updated_at, update_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?9, ?11, ?12, ?13, ?14, ?15, ?16, ?16, :cursor)`,
        assetId,
        user.id,
        fields.deviceAssetId ?? `web-${file.filename}-${Date.now()}`,
        fields.deviceId ?? 'WEB',
        file.type,
        file.key,
        fields.filename ?? file.filename,
        file.checksum,
        createdAt,
        new Date(fields.fileModifiedAt).toISOString(),
        duration,
        fields.isFavorite === 'true' ? 1 : 0,
        fields.visibility ?? 'timeline',
        fields.livePhotoVideoId ?? null,
        file.size,
        now,
      ),
      db.prepare('UPDATE users SET usage_bytes = usage_bytes + ?1 WHERE id = ?2').bind(file.size, user.id),
    ]);
  } catch (err) {
    await c.env.MEDIA.delete(file.key);
    if (String(err).includes('UNIQUE')) {
      const existing = await findByChecksum(db, user.id, file.checksum);
      if (existing) return c.json({ id: existing.id, status: 'duplicate' }, 200);
    }
    throw err;
  }

  await c.env.PROCESS_QUEUE.send({ assetId } satisfies ProcessMessage);
  return c.json({ id: assetId, status: 'created' }, 201);
});

/** Immich clients send duration as "H:MM:SS.ffffff" or as milliseconds; stored as milliseconds. */
function parseDuration(value: string): number | null {
  if (/^\d+$/.test(value)) return Number(value);
  const m = value.match(/^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/);
  if (!m) return null;
  return Math.round((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000);
}

uploadRoutes.post('/assets/bulk-upload-check', requireAuth, async (c) => {
  const { user } = c.get('auth');
  const { assets } = await c.req.json<{ assets: Array<{ id: string; checksum: string }> }>();
  const results = [];
  for (const item of assets) {
    const existing = await findByChecksum(c.env.DB, user.id, normaliseChecksum(item.checksum));
    results.push(
      existing
        ? { id: item.id, action: 'reject' as const, reason: 'duplicate' as const, assetId: existing.id, isTrashed: existing.deleted_at !== null }
        : { id: item.id, action: 'accept' as const },
    );
  }
  return c.json({ results });
});
```

The bulk check runs one query per item; the web app sends at most a few hundred per call, under the D1 per-invocation limit. If a test library check exceeds 900 items, return 400 `Too many assets in one check`; add that guard as the first line of the handler:

```ts
  if (assets.length > 900) throw new ImmichError(400, 'Too many assets in one check');
```

Modify `src/app.ts`: import `uploadRoutes` and add `api.route('/', uploadRoutes);`.

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run test/upload.test.ts && npm run typecheck`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Add streaming asset upload with SHA-1 dedupe and bulk upload check"
```

---

### Task 9: EXIF extraction

**Files:**
- Create: `src/process/exif.ts`
- Test: `test/exif.test.ts`

**Interfaces:**
- Produces:
  - `interface ExtractedExif` with the `asset_exif` columns (camelCase) plus `width`, `height`
  - `extractExif(bytes: Uint8Array): Promise<ExtractedExif>` (never throws; returns all-null on unreadable input)
  - `localDateTime(dateTimeOriginal: string | null, timeZone: string | null, fallbackUtc: string): string` (ISO string where the clock time is local time, marked `Z`, as Immich stores `localDateTime`)

- [ ] **Step 1: Write the failing test**

`test/exif.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { extractExif, localDateTime } from '../src/process/exif';
import sampleJpg from './fixtures/media/sample.jpg?arraybuffer';
import noExifPng from './fixtures/media/no-exif.png?arraybuffer';

describe('extractExif', () => {
  it('reads camera, date and GPS from the sample JPEG', async () => {
    const e = await extractExif(new Uint8Array(sampleJpg));
    expect(e.make).toBeTruthy();
    expect(e.dateTimeOriginal).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(e.latitude).toBeTypeOf('number');
    expect(e.longitude).toBeTypeOf('number');
    expect(e.width).toBeGreaterThan(0);
  });

  it('returns nulls for a PNG without EXIF', async () => {
    const e = await extractExif(new Uint8Array(noExifPng));
    expect(e.make).toBeNull();
    expect(e.dateTimeOriginal).toBeNull();
  });

  it('returns nulls for garbage', async () => {
    const e = await extractExif(new Uint8Array([1, 2, 3]));
    expect(e.dateTimeOriginal).toBeNull();
  });
});

describe('localDateTime', () => {
  it('keeps the local clock time of the capture', () => {
    expect(localDateTime('2024-05-04T09:00:00.000Z', '+02:00', '2024-05-04T09:00:00.000Z')).toBe('2024-05-04T11:00:00.000Z');
  });
  it('falls back to the UTC upload date', () => {
    expect(localDateTime(null, null, '2024-05-04T10:00:00.000Z')).toBe('2024-05-04T10:00:00.000Z');
  });
});
```

The `?arraybuffer` import suffix is not built in. Add a Vite plugin at the top level of the config object returned in `vitest.config.ts` (sibling of `test`) so fixtures load as `ArrayBuffer` in workerd:

```ts
    plugins: [
      {
        name: 'arraybuffer-loader',
        async load(id: string) {
          if (!id.endsWith('?arraybuffer')) return null;
          const { readFile } = await import('node:fs/promises');
          const b64 = (await readFile(id.slice(0, -'?arraybuffer'.length))).toString('base64');
          return `const s = atob(${JSON.stringify(b64)}); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); export default u.buffer;`;
        },
      },
    ],
```

and create `test/arraybuffer.d.ts`:

```ts
declare module '*?arraybuffer' {
  const buffer: ArrayBuffer;
  export default buffer;
}
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run test/exif.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/process/exif.ts`:

```ts
import exifr from 'exifr';

export interface ExtractedExif {
  make: string | null;
  model: string | null;
  lensModel: string | null;
  exposureTime: string | null;
  fNumber: number | null;
  focalLength: number | null;
  iso: number | null;
  latitude: number | null;
  longitude: number | null;
  dateTimeOriginal: string | null;
  modifyDate: string | null;
  timeZone: string | null;
  orientation: string | null;
  rating: number | null;
  description: string | null;
  exifImageWidth: number | null;
  exifImageHeight: number | null;
  profileDescription: string | null;
  projectionType: string | null;
  width: number | null;
  height: number | null;
}

const EMPTY: ExtractedExif = {
  make: null, model: null, lensModel: null, exposureTime: null, fNumber: null, focalLength: null, iso: null,
  latitude: null, longitude: null, dateTimeOriginal: null, modifyDate: null, timeZone: null, orientation: null,
  rating: null, description: null, exifImageWidth: null, exifImageHeight: null, profileDescription: null,
  projectionType: null, width: null, height: null,
};

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const iso = (v: unknown) => (v instanceof Date && !Number.isNaN(v.getTime()) ? v.toISOString() : null);

function exposure(v: unknown): string | null {
  const n = num(v);
  if (n === null) return null;
  return n >= 1 ? String(n) : `1/${Math.round(1 / n)}`;
}

export async function extractExif(bytes: Uint8Array): Promise<ExtractedExif> {
  let t: Record<string, any> | undefined;
  try {
    t = await exifr.parse(bytes, { tiff: true, exif: true, gps: true, icc: true, xmp: true, iptc: false, translateValues: false, reviveValues: true, mergeOutput: true });
  } catch {
    return { ...EMPTY };
  }
  if (!t) return { ...EMPTY };
  const offset = str(t.OffsetTimeOriginal) ?? str(t.OffsetTime);
  const orientation = num(t.Orientation);
  const w = num(t.ExifImageWidth) ?? num(t.ImageWidth);
  const h = num(t.ExifImageHeight) ?? num(t.ImageHeight);
  const swap = orientation !== null && orientation >= 5;
  return {
    make: str(t.Make),
    model: str(t.Model),
    lensModel: str(t.LensModel),
    exposureTime: exposure(t.ExposureTime),
    fNumber: num(t.FNumber),
    focalLength: num(t.FocalLength),
    iso: num(t.ISO),
    latitude: num(t.latitude),
    longitude: num(t.longitude),
    dateTimeOriginal: iso(t.DateTimeOriginal) ?? iso(t.CreateDate),
    modifyDate: iso(t.ModifyDate),
    timeZone: offset,
    orientation: orientation === null ? null : String(orientation),
    rating: num(t.Rating),
    description: str(t.ImageDescription) ?? str(t.description),
    exifImageWidth: w,
    exifImageHeight: h,
    profileDescription: str(t.ProfileDescription),
    projectionType: str(t.ProjectionType)?.toUpperCase() ?? null,
    width: swap ? h : w,
    height: swap ? w : h,
  };
}

/**
 * Immich stores localDateTime as the local wall-clock time of capture, marked UTC.
 * exifr revives DateTimeOriginal using OffsetTimeOriginal when present, so shift back by the offset.
 */
export function localDateTime(dateTimeOriginal: string | null, timeZone: string | null, fallbackUtc: string): string {
  if (!dateTimeOriginal) return new Date(fallbackUtc).toISOString();
  const m = timeZone?.match(/^([+-])(\d{2}):(\d{2})$/);
  if (!m) return new Date(dateTimeOriginal).toISOString();
  const minutes = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  return new Date(new Date(dateTimeOriginal).getTime() + minutes * 60_000).toISOString();
}
```

If exifr's revived `DateTimeOriginal` for the sample JPEG does not already apply the offset (check by printing `t.DateTimeOriginal` and `t.OffsetTimeOriginal` for `sample.jpg` and comparing with `exiftool -DateTimeOriginal -OffsetTimeOriginal sample.jpg`), adjust `localDateTime` so the test's expectation (local clock time marked `Z`) holds for the sample, and add a test case built from the sample's own values.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/exif.test.ts && npm run typecheck`
Expected: all pass. If `import exifr from 'exifr'` fails to bundle in workerd, import the browser ESM build explicitly: `import exifr from 'exifr/dist/full.esm.mjs';` and add `declare module 'exifr/dist/full.esm.mjs' { export { default } from 'exifr'; }` to `src/gen/exifr.d.ts`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add EXIF extraction with exifr"
```

---

### Task 10: Processing consumer (thumbnails, thumbhash, status)

**Files:**
- Create: `src/process/thumbs.ts`, `src/process/consumer.ts`, `src/process/routes.ts`
- Modify: `src/index.ts`, `src/app.ts`
- Test: `test/process.test.ts`

**Interfaces:**
- Consumes: `extractExif`, `localDateTime`, `tracked`, `commit`, `ProcessMessage`.
- Produces:
  - `interface Thumbnailer { render(input: Uint8Array, opts: { width: number; format: 'image/webp' | 'image/jpeg' | 'image/png'; quality?: number }): Promise<Uint8Array> }`
  - `imagesThumbnailer(images: ImagesBinding): Thumbnailer`
  - `thumbhashFromPng(png: Uint8Array): string` (base64)
  - `thumbKey(assetId: string, size: 'thumbnail' | 'preview'): string` → `thumbs/<id>/thumbnail.webp` or `thumbs/<id>/preview.jpeg`
  - `THUMBNAIL_INPUTS: Set<string>` (extensions the Images binding accepts) and `MAX_THUMBNAIL_INPUT = 20 * 1024 * 1024`
  - `processAsset(env: Env, assetId: string, thumbnailer: Thumbnailer): Promise<void>`
  - `handleProcessBatch(batch: MessageBatch<ProcessMessage>, env: Env, thumbnailer?: Thumbnailer): Promise<void>`

- [ ] **Step 1: Write the failing tests**

`test/process.test.ts`:

```ts
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { encode } from 'fast-png';
import { processAsset } from '../src/process/consumer';
import type { Thumbnailer } from '../src/process/thumbs';
import { createUser, login, uploadAsset } from './helpers';
import sampleJpg from './fixtures/media/sample.jpg?arraybuffer';

/** Fake Images binding: returns a 4x3 solid PNG for every render, records calls. */
function fakeThumbnailer(fail = false): Thumbnailer & { calls: Array<{ width: number; format: string }> } {
  const png = encode({ width: 4, height: 3, data: new Uint8Array(4 * 3 * 4).fill(200), channels: 4 });
  const calls: Array<{ width: number; format: string }> = [];
  return {
    calls,
    async render(_input, opts) {
      if (fail) throw new Error('ERROR 9412: Unsupported image');
      calls.push({ width: opts.width, format: opts.format });
      return png;
    },
  };
}

async function uploaded(filename = 'IMG_0001.JPG', bytes = new Uint8Array(sampleJpg)) {
  await createUser();
  const token = await login();
  return (await uploadAsset(token, bytes, { filename })).body.id;
}

describe('processAsset', () => {
  it('writes thumbnails, thumbhash, exif and marks ready with new cursors', async () => {
    const id = await uploaded();
    const before = await env.DB.prepare('SELECT update_id FROM assets WHERE id = ?1').bind(id).first<string>('update_id');
    const t = fakeThumbnailer();
    await processAsset(env, id, t);
    expect(t.calls).toEqual([
      { width: 1440, format: 'image/jpeg' },
      { width: 250, format: 'image/webp' },
      { width: 100, format: 'image/png' },
    ]);
    const a = await env.DB.prepare('SELECT * FROM assets WHERE id = ?1').bind(id).first<any>();
    expect(a.status).toBe('ready');
    expect(a.has_thumbnail).toBe(1);
    expect(a.thumbhash).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(a.update_id > before!).toBe(true);
    expect(await env.MEDIA.head(`thumbs/${id}/thumbnail.webp`)).not.toBeNull();
    expect(await env.MEDIA.head(`thumbs/${id}/preview.jpeg`)).not.toBeNull();
    const exif = await env.DB.prepare('SELECT * FROM asset_exif WHERE asset_id = ?1').bind(id).first<any>();
    expect(exif.make).toBeTruthy();
    expect(exif.file_size_in_byte).toBe(a.file_size);
    expect(a.local_date_time).not.toBe(a.file_created_at); // taken from EXIF, not the upload field
  });

  it('is idempotent when the same message is delivered twice', async () => {
    const id = await uploaded();
    await processAsset(env, id, fakeThumbnailer());
    await processAsset(env, id, fakeThumbnailer());
    expect(await env.DB.prepare('SELECT count(*) AS n FROM asset_exif').first('n')).toBe(1);
  });

  it('unsupported input marks needs_media and writes no thumbnails', async () => {
    const id = await uploaded('clip.mov', crypto.getRandomValues(new Uint8Array(2048)));
    await processAsset(env, id, fakeThumbnailer());
    const a = await env.DB.prepare('SELECT status, has_thumbnail, local_date_time, file_created_at FROM assets WHERE id = ?1').bind(id).first<any>();
    expect(a.status).toBe('needs_media');
    expect(a.has_thumbnail).toBe(0);
    expect(a.local_date_time).toBe(a.file_created_at);
    expect(await env.MEDIA.head(`thumbs/${id}/thumbnail.webp`)).toBeNull();
  });

  it('a rendering failure marks failed with the error and does not throw', async () => {
    const id = await uploaded();
    await processAsset(env, id, fakeThumbnailer(true));
    const a = await env.DB.prepare('SELECT status, error FROM assets WHERE id = ?1').bind(id).first<any>();
    expect(a.status).toBe('failed');
    expect(a.error).toContain('9412');
  });

  it('ignores a message for a deleted asset', async () => {
    await createUser();
    await expect(processAsset(env, crypto.randomUUID(), fakeThumbnailer())).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run test/process.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement thumbnails**

`src/process/thumbs.ts`:

```ts
import { decode } from 'fast-png';
import { rgbaToThumbHash } from 'thumbhash';
import { toBase64 } from '../upload/r2-writer';

export interface Thumbnailer {
  render(input: Uint8Array, opts: { width: number; format: 'image/webp' | 'image/jpeg' | 'image/png'; quality?: number }): Promise<Uint8Array>;
}

export const THUMBNAIL_INPUTS = new Set(['.jpg', '.jpeg', '.jpe', '.jfif', '.png', '.heic', '.heif', '.hif', '.webp', '.gif']);
export const MAX_THUMBNAIL_INPUT = 20 * 1024 * 1024;

export function thumbKey(assetId: string, size: 'thumbnail' | 'preview'): string {
  return size === 'thumbnail' ? `thumbs/${assetId}/thumbnail.webp` : `thumbs/${assetId}/preview.jpeg`;
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}

export function imagesThumbnailer(images: ImagesBinding): Thumbnailer {
  return {
    async render(input, opts) {
      const result = await images
        .input(streamOf(input))
        .transform({ width: opts.width, height: opts.width, fit: 'scale-down' })
        .output({ format: opts.format, quality: opts.quality ?? 80 });
      return new Uint8Array(await result.response().arrayBuffer());
    },
  };
}

export function thumbhashFromPng(png: Uint8Array): string {
  const img = decode(png);
  const { width, height } = img;
  const channels = img.channels;
  const src = img.data as Uint8Array;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = src[i * channels];
    rgba[i * 4 + 1] = src[i * channels + (channels >= 3 ? 1 : 0)];
    rgba[i * 4 + 2] = src[i * channels + (channels >= 3 ? 2 : 0)];
    rgba[i * 4 + 3] = channels === 4 ? src[i * 4 + 3] : channels === 2 ? src[i * 2 + 1] : 255;
  }
  return toBase64(rgbaToThumbHash(width, height, rgba));
}
```

The 100 px PNG keeps thumbhash input under its 100×100 limit; `fit: 'scale-down'` with `width` and `height` both set bounds the longer side.

- [ ] **Step 4: Implement the consumer**

`src/process/consumer.ts`:

```ts
import { commit, tracked } from '../db/changes';
import type { AssetRow } from '../db/rows';
import { extensionOf } from '../upload/media-types';
import type { ProcessMessage } from '../upload/routes';
import { extractExif, localDateTime, type ExtractedExif } from './exif';
import { imagesThumbnailer, MAX_THUMBNAIL_INPUT, THUMBNAIL_INPUTS, thumbhashFromPng, thumbKey, type Thumbnailer } from './thumbs';

function exifStatement(a: AssetRow, e: ExtractedExif) {
  return tracked(
    `INSERT INTO asset_exif (asset_id, owner_id, make, model, lens_model, exposure_time, f_number, focal_length, iso,
       latitude, longitude, date_time_original, modify_date, time_zone, orientation, rating, description,
       exif_image_width, exif_image_height, file_size_in_byte, profile_description, projection_type, update_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, :cursor)
     ON CONFLICT (asset_id) DO UPDATE SET make = excluded.make, model = excluded.model, lens_model = excluded.lens_model,
       exposure_time = excluded.exposure_time, f_number = excluded.f_number, focal_length = excluded.focal_length,
       iso = excluded.iso, latitude = excluded.latitude, longitude = excluded.longitude,
       date_time_original = excluded.date_time_original, modify_date = excluded.modify_date, time_zone = excluded.time_zone,
       orientation = excluded.orientation, rating = excluded.rating, description = excluded.description,
       exif_image_width = excluded.exif_image_width, exif_image_height = excluded.exif_image_height,
       file_size_in_byte = excluded.file_size_in_byte, profile_description = excluded.profile_description,
       projection_type = excluded.projection_type, update_id = excluded.update_id`,
    a.id, a.owner_id, e.make, e.model, e.lensModel, e.exposureTime, e.fNumber, e.focalLength, e.iso,
    e.latitude, e.longitude, e.dateTimeOriginal, e.modifyDate, e.timeZone, e.orientation, e.rating, e.description,
    e.exifImageWidth, e.exifImageHeight, a.file_size, e.profileDescription, e.projectionType,
  );
}

export async function processAsset(env: Env, assetId: string, thumbnailer: Thumbnailer): Promise<void> {
  const db = env.DB;
  const a = await db.prepare('SELECT * FROM assets WHERE id = ?1').bind(assetId).first<AssetRow>();
  if (!a) return;
  const now = new Date().toISOString();
  const ext = extensionOf(a.original_path);

  if (a.type !== 'IMAGE' || !THUMBNAIL_INPUTS.has(ext) || a.file_size > MAX_THUMBNAIL_INPUT) {
    await commit(db, [
      tracked(`UPDATE assets SET status = 'needs_media', updated_at = ?2, update_id = :cursor WHERE id = ?1`, a.id, now),
    ]);
    return;
  }

  const object = await env.MEDIA.get(a.original_path);
  if (!object) {
    await commit(db, [
      tracked(`UPDATE assets SET status = 'failed', error = 'original missing', updated_at = ?2, update_id = :cursor WHERE id = ?1`, a.id, now),
    ]);
    return;
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  const exif = await extractExif(bytes);

  let thumbhash: string;
  try {
    const preview = await thumbnailer.render(bytes, { width: 1440, format: 'image/jpeg', quality: 80 });
    await env.MEDIA.put(thumbKey(a.id, 'preview'), preview, { httpMetadata: { contentType: 'image/jpeg' } });
    const thumb = await thumbnailer.render(bytes, { width: 250, format: 'image/webp', quality: 80 });
    await env.MEDIA.put(thumbKey(a.id, 'thumbnail'), thumb, { httpMetadata: { contentType: 'image/webp' } });
    thumbhash = thumbhashFromPng(await thumbnailer.render(bytes, { width: 100, format: 'image/png' }));
  } catch (err) {
    await commit(db, [
      exifStatement(a, exif),
      tracked(`UPDATE assets SET status = 'failed', error = ?2, updated_at = ?3, update_id = :cursor WHERE id = ?1`, a.id, String(err).slice(0, 500), now),
    ]);
    return;
  }

  await commit(db, [
    exifStatement(a, exif),
    tracked(
      `UPDATE assets SET status = 'ready', error = NULL, has_thumbnail = 1, thumbhash = ?2, width = ?3, height = ?4,
         local_date_time = ?5, updated_at = ?6, update_id = :cursor WHERE id = ?1`,
      a.id,
      thumbhash,
      exif.width,
      exif.height,
      localDateTime(exif.dateTimeOriginal, exif.timeZone, a.file_created_at),
      now,
    ),
  ]);
  await env.BACKUP_QUEUE.send({ assetId: a.id });
}

export async function handleProcessBatch(batch: MessageBatch<ProcessMessage>, env: Env, thumbnailer?: Thumbnailer): Promise<void> {
  const t = thumbnailer ?? imagesThumbnailer(env.IMAGES);
  for (const msg of batch.messages) {
    try {
      await processAsset(env, msg.body.assetId, t);
      msg.ack();
    } catch (err) {
      console.error('process failed', msg.body.assetId, err);
      msg.retry();
    }
  }
}
```

Admin re-enqueue for failed assets (spec section 7.2 step 4). This is not an Immich endpoint, so it lives under `/api/admin-cf/`. Create `src/process/routes.ts`:

```ts
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { requireAuth } from '../auth/session';
import { ImmichError } from '../http/errors';

export const processRoutes = new Hono<AppEnv>();

processRoutes.post('/admin-cf/reprocess-failed', requireAuth, async (c) => {
  if (c.get('auth').user.is_admin !== 1) throw new ImmichError(403, 'Admin only');
  const { results } = await c.env.DB.prepare("SELECT id FROM assets WHERE status = 'failed' LIMIT 5000").all<{ id: string }>();
  for (let i = 0; i < results.length; i += 100) {
    await c.env.PROCESS_QUEUE.sendBatch(results.slice(i, i + 100).map((r) => ({ body: { assetId: r.id } })));
  }
  return c.json({ queued: results.length });
});
```

Add `api.route('/', processRoutes);` in `src/app.ts`, and append to `test/process.test.ts`:

```ts
import { SELF } from 'cloudflare:test';
import { authHeaders, BASE } from './helpers';

describe('reprocess-failed', () => {
  it('re-enqueues failed assets for admins only', async () => {
    const id = await uploaded();
    await processAsset(env, id, fakeThumbnailer(true));
    const token = await login();
    const res = await SELF.fetch(`${BASE}/api/admin-cf/reprocess-failed`, { method: 'POST', headers: authHeaders(token) });
    expect(await res.json()).toEqual({ queued: 1 });
    await createUser({ email: 'kid@example.com', isAdmin: false });
    const other = await login('kid@example.com');
    const denied = await SELF.fetch(`${BASE}/api/admin-cf/reprocess-failed`, { method: 'POST', headers: authHeaders(other) });
    expect(denied.status).toBe(403);
  });
});
```

(Merge the two new imports into the file's existing import lines.)

`needs_media` and `failed` assets are not sent to the backup queue here; Task 15's weekly cron re-enqueues every asset with `backed_up_at IS NULL` whose status is not `pending`, so their originals are still copied.

Modify `src/index.ts`:

```ts
import { app } from './app';
import { handleProcessBatch } from './process/consumer';
import type { ProcessMessage } from './upload/routes';

export default {
  fetch: app.fetch,
  async queue(batch, env) {
    if (env.DISABLE_QUEUE_CONSUMERS) return batch.ackAll(); // set only in tests
    if (batch.queue === 'asset-process') await handleProcessBatch(batch as MessageBatch<ProcessMessage>, env);
  },
} satisfies ExportedHandler<Env, ProcessMessage>;
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/process.test.ts && npm run typecheck`
Expected: all pass. If `ImagesBinding` is not the type name in `worker-configuration.d.ts`, use the type that `wrangler types` generated for `env.IMAGES`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Add asset processing consumer: EXIF, thumbnails via Images binding, thumbhash"
```

---

### Task 11: Sync stream and acks

**Files:**
- Create: `src/sync/acks.ts`, `src/sync/passes.ts`, `src/sync/routes.ts`
- Modify: `src/app.ts`
- Test: `test/sync.test.ts`

**Interfaces:**
- Consumes: `nowCursor`, `formatCursor`, `mapSyncAuthUser`, `mapSyncUser`, `requireAuth`, row types.
- Produces:
  - `parseAck(ack: string): { type: string; id: string }` (throws `ImmichError(400)` on unknown entity type)
  - `ENTITY_TYPES: Set<string>` (all `SyncEntityType` values from the pinned spec)
  - `RESET_BEFORE: string | null` constant in `src/sync/acks.ts` (bump when a migration changes an entity's shape)
  - `needsReset(session: SessionRow): boolean`
  - `interface Pass { entity: string; fetch(db: D1Database, userId: string, after: string, now: string, limit: number): Promise<Array<{ cursor: string; data: unknown }>> }`
  - `PASSES: Record<string, Pass[]>` keyed by request type, in Immich order
  - `REQUEST_ORDER: string[]`
  - `mapSyncAsset(a: AssetRow): Dto<'SyncAssetV2'>`, `mapSyncExif(e: ExifRow): Dto<'SyncAssetExifV1'>`
  - `QUERY_BUDGET = 950`, `PAGE_SIZE = 500` (both overridable for tests via `streamSync(..., { pageSize, queryBudget })`)
  - `streamSync(db, auth, types, opts?): ReadableStream<Uint8Array>`

- [ ] **Step 1: Write the failing tests**

`test/sync.test.ts`:

```ts
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { commit, tracked } from '../src/db/changes';
import { findSession } from '../src/auth/session';
import { streamSync } from '../src/sync/routes';
import { expectSchema } from './contract';
import { authHeaders, BASE, createUser, login, uploadAsset } from './helpers';

type Line = { type: string; data: Record<string, unknown>; ack: string };

async function sync(token: string, types: string[]): Promise<Line[]> {
  const res = await SELF.fetch(`${BASE}/api/sync/stream`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'content-type': 'application/json', accept: 'application/jsonlines+json' },
    body: JSON.stringify({ types }),
  });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('application/jsonlines+json');
  return (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function ack(token: string, acks: string[]) {
  const res = await SELF.fetch(`${BASE}/api/sync/ack`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify({ acks }),
  });
  expect(res.status).toBeLessThan(300);
}

/** Mimics the client: ack the last line of each run of same-type lines. */
function clientAcks(lines: Line[]): string[] {
  const out: string[] = [];
  lines.forEach((l, i) => {
    if (l.type === 'SyncCompleteV1') return;
    if (i === lines.length - 1 || lines[i + 1].type !== l.type) out.push(l.ack);
  });
  return out;
}

const ALL = ['AuthUsersV2', 'UsersV1', 'AssetsV2', 'AssetExifsV1', 'MemoriesV2', 'AssetOcrV1'];

describe('sync stream', () => {
  it('emits own user, users, assets in Immich order, ending with SyncCompleteV1', async () => {
    await createUser();
    const token = await login();
    await uploadAsset(token, crypto.getRandomValues(new Uint8Array(100)));
    const lines = await sync(token, ALL);
    expect(lines.map((l) => l.type)).toEqual(['AuthUserV2', 'UserV1', 'AssetV2', 'SyncCompleteV1']);
    expectSchema('SyncAuthUserV2', lines[0].data);
    expectSchema('SyncUserV1', lines[1].data);
    expectSchema('SyncAssetV2', lines[2].data);
    expect(lines[2].ack).toMatch(/^AssetV2\|00000000-0000-7000-8000-[0-9a-f]{12}$/);
    expect(lines[3].ack).toMatch(/^SyncCompleteV1\|/);
  });

  it('acked rows are not sent again; new and changed rows are', async () => {
    await createUser();
    const token = await login();
    const a = await uploadAsset(token, crypto.getRandomValues(new Uint8Array(100)));
    await ack(token, clientAcks(await sync(token, ALL)));
    expect((await sync(token, ALL)).map((l) => l.type)).toEqual(['SyncCompleteV1']);
    await commit(env.DB, [tracked('UPDATE assets SET is_favorite = 1, update_id = :cursor WHERE id = ?1', a.body.id)]);
    const lines = await sync(token, ALL);
    expect(lines.map((l) => l.type)).toEqual(['AssetV2', 'SyncCompleteV1']);
    expect(lines[0].data.isFavorite).toBe(true);
  });

  it('trash is an AssetV2 with deletedAt, purge is an AssetDeleteV1', async () => {
    await createUser();
    const token = await login();
    const a = await uploadAsset(token, crypto.getRandomValues(new Uint8Array(100)));
    await ack(token, clientAcks(await sync(token, ALL)));
    await commit(env.DB, [tracked("UPDATE assets SET deleted_at = '2026-01-01T00:00:00.000Z', update_id = :cursor WHERE id = ?1", a.body.id)]);
    let lines = await sync(token, ALL);
    expect(lines[0].type).toBe('AssetV2');
    expect(lines[0].data.deletedAt).toBe('2026-01-01T00:00:00.000Z');
    await ack(token, clientAcks(lines));
    const owner = (await env.DB.prepare('SELECT owner_id FROM assets').first<string>('owner_id'))!;
    await commit(env.DB, [
      env.DB.prepare('DELETE FROM assets WHERE id = ?1').bind(a.body.id),
      tracked("INSERT INTO asset_audit (id, asset_id, owner_id, deleted_at) VALUES (:cursor, ?1, ?2, '2026-02-01T00:00:00.000Z')", a.body.id, owner),
    ]);
    lines = await sync(token, ALL);
    expect(lines.map((l) => l.type)).toEqual(['AssetDeleteV1', 'SyncCompleteV1']);
    expect(lines[0].data).toEqual({ assetId: a.body.id });
  });

  it('rows sharing a commit straddle a page boundary and both arrive', async () => {
    await createUser();
    const token = await login();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await uploadAsset(token, crypto.getRandomValues(new Uint8Array(50 + i)))).body.id);
    await ack(token, clientAcks(await sync(token, ALL)));
    await commit(env.DB, ids.map((id) => tracked('UPDATE assets SET is_favorite = 1, update_id = :cursor WHERE id = ?1', id)));
    const session = (await findSession(env.DB, token))!;
    const text = await new Response(streamSync(env.DB, session, ['AssetsV2'], { pageSize: 2 })).text();
    const got = text.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.type === 'AssetV2').map((l) => l.data.id);
    expect(got.sort()).toEqual([...ids].sort());
  });

  it('stream stops at query budget and resumes', async () => {
    await createUser();
    const token = await login();
    for (let i = 0; i < 5; i++) await uploadAsset(token, crypto.getRandomValues(new Uint8Array(60 + i)));
    const session = (await findSession(env.DB, token))!;
    // Budget 4 = 2 setup queries + the empty AssetDeleteV1 page + one 2-row AssetV2 page per stream.
    const read = async () =>
      (await new Response(streamSync(env.DB, session, ['AssetsV2'], { pageSize: 2, queryBudget: 4 })).text())
        .split('\n').filter(Boolean).map((l) => JSON.parse(l) as Line);
    const seen: string[] = [];
    let streams = 0;
    for (;;) {
      const lines = await read();
      streams++;
      seen.push(...lines.filter((l) => l.type === 'AssetV2').map((l) => l.data.id as string));
      if (lines.at(-1)?.type === 'SyncCompleteV1') break;
      await ack(token, clientAcks(lines));
      if (streams > 10) throw new Error('sync made no progress');
    }
    expect(streams).toBe(3);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it('SyncResetV1 ack clears checkpoints so the next stream is a full resync', async () => {
    await createUser();
    const token = await login();
    await uploadAsset(token, crypto.getRandomValues(new Uint8Array(100)));
    await ack(token, clientAcks(await sync(token, ALL)));
    await ack(token, ['SyncResetV1|reset']);
    const lines = await sync(token, ALL);
    expect(lines.map((l) => l.type)).toEqual(['AuthUserV2', 'UserV1', 'AssetV2', 'SyncCompleteV1']);
  });

  it('reset:true in the request clears checkpoints first', async () => {
    await createUser();
    const token = await login();
    await uploadAsset(token, crypto.getRandomValues(new Uint8Array(100)));
    await ack(token, clientAcks(await sync(token, ALL)));
    const res = await SELF.fetch(`${BASE}/api/sync/stream`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ types: ALL, reset: true }),
    });
    expect((await res.text()).split('\n').filter(Boolean)).toHaveLength(4);
  });

  it('DELETE /sync/ack accepts unimplemented entity types; unknown types are 400', async () => {
    await createUser();
    const token = await login();
    const del = await SELF.fetch(`${BASE}/api/sync/ack`, {
      method: 'DELETE',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ types: ['AssetV1', 'PartnerAssetV1', 'AlbumAssetCreateV1'] }),
    });
    expect(del.status).toBeLessThan(300);
    const bad = await SELF.fetch(`${BASE}/api/sync/ack`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({ acks: ['NotAType|x'] }),
    });
    expect(bad.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run test/sync.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement acks**

`src/sync/acks.ts`:

```ts
import spec from '../../vendor/immich-openapi.json';
import type { SessionRow } from '../db/rows';
import { ImmichError } from '../http/errors';

export const ENTITY_TYPES = new Set<string>((spec as any).components.schemas.SyncEntityType.enum);

/** Bump to an ISO timestamp in the same commit as a migration that changes a synced entity's shape. */
export const RESET_BEFORE: string | null = null;

export function parseAck(ack: string): { type: string; id: string } {
  const [type, id] = ack.split('|');
  if (!type || !ENTITY_TYPES.has(type) || id === undefined) throw new ImmichError(400, `Invalid ack: ${ack}`);
  return { type, id };
}

export function needsReset(session: SessionRow): boolean {
  if (!RESET_BEFORE) return false;
  const since = session.reset_at && session.reset_at > session.created_at ? session.reset_at : session.created_at;
  return since < RESET_BEFORE;
}

export async function getCheckpoints(db: D1Database, sessionId: string): Promise<Map<string, string>> {
  const { results } = await db
    .prepare('SELECT entity_type, ack FROM sync_checkpoints WHERE session_id = ?1')
    .bind(sessionId)
    .all<{ entity_type: string; ack: string }>();
  return new Map(results.map((r) => [r.entity_type, parseAck(r.ack).id]));
}

export async function resetSession(db: D1Database, sessionId: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM sync_checkpoints WHERE session_id = ?1').bind(sessionId),
    db.prepare('UPDATE sessions SET reset_at = ?2 WHERE id = ?1').bind(sessionId, new Date().toISOString()),
  ]);
}

export async function setAcks(db: D1Database, sessionId: string, acks: string[]): Promise<void> {
  const parsed = acks.map(parseAck);
  if (parsed.some((a) => a.type === 'SyncResetV1')) return resetSession(db, sessionId);
  const stmts = parsed
    .filter((a) => a.type !== 'SyncCompleteV1')
    .map((a) =>
      db
        .prepare(
          'INSERT INTO sync_checkpoints (session_id, entity_type, ack) VALUES (?1, ?2, ?3) ON CONFLICT (session_id, entity_type) DO UPDATE SET ack = excluded.ack',
        )
        .bind(sessionId, a.type, `${a.type}|${a.id}`),
    );
  if (stmts.length) await db.batch(stmts);
}

export async function deleteAcks(db: D1Database, sessionId: string, types: string[] | undefined): Promise<void> {
  if (!types || types.length === 0) {
    await db.prepare('DELETE FROM sync_checkpoints WHERE session_id = ?1').bind(sessionId).run();
    return;
  }
  for (const t of types) if (!ENTITY_TYPES.has(t)) throw new ImmichError(400, `Unknown sync type ${t}`);
  await db.batch(types.map((t) => db.prepare('DELETE FROM sync_checkpoints WHERE session_id = ?1 AND entity_type = ?2').bind(sessionId, t)));
}
```

- [ ] **Step 4: Implement passes**

`src/sync/passes.ts`:

```ts
import type { AssetRow, ExifRow, UserRow } from '../db/rows';
import type { Dto } from '../gen/dto';
import { mapSyncAuthUser, mapSyncUser } from '../users/map';

export interface Pass {
  entity: string;
  fetch(db: D1Database, userId: string, after: string, now: string, limit: number): Promise<Array<{ cursor: string; data: unknown }>>;
}

export function mapSyncAsset(a: AssetRow): Dto<'SyncAssetV2'> {
  return {
    id: a.id,
    ownerId: a.owner_id,
    originalFileName: a.original_file_name,
    checksum: a.checksum,
    type: a.type,
    visibility: a.visibility,
    isFavorite: a.is_favorite === 1,
    isEdited: false,
    fileCreatedAt: a.file_created_at,
    fileModifiedAt: a.file_modified_at,
    localDateTime: a.local_date_time,
    createdAt: a.created_at,
    deletedAt: a.deleted_at,
    duration: a.duration,
    width: a.width,
    height: a.height,
    thumbhash: a.thumbhash,
    livePhotoVideoId: a.live_photo_video_id,
    stackId: null,
    libraryId: null,
  };
}

export function mapSyncExif(e: ExifRow): Dto<'SyncAssetExifV1'> {
  return {
    assetId: e.asset_id,
    make: e.make, model: e.model, lensModel: e.lens_model, exposureTime: e.exposure_time,
    fNumber: e.f_number, focalLength: e.focal_length, iso: e.iso,
    latitude: e.latitude, longitude: e.longitude, city: e.city, state: e.state, country: e.country,
    dateTimeOriginal: e.date_time_original, modifyDate: e.modify_date, timeZone: e.time_zone,
    orientation: e.orientation, rating: e.rating, description: e.description,
    exifImageWidth: e.exif_image_width, exifImageHeight: e.exif_image_height, fileSizeInByte: e.file_size_in_byte,
    profileDescription: e.profile_description, projectionType: e.projection_type, fps: e.fps,
  };
}

function rows<T>(db: D1Database, sql: string, ...binds: unknown[]) {
  return db.prepare(sql).bind(...binds).all<T>().then((r) => r.results);
}

const authUsers: Pass = {
  entity: 'AuthUserV2',
  async fetch(db, userId, after, now, limit) {
    const r = await rows<UserRow>(db, 'SELECT * FROM users WHERE id = ?1 AND update_id > ?2 AND update_id <= ?3 ORDER BY update_id LIMIT ?4', userId, after, now, limit);
    return r.map((u) => ({ cursor: u.update_id, data: mapSyncAuthUser(u) }));
  },
};

const userDeletes: Pass = {
  entity: 'UserDeleteV1',
  async fetch(db, _userId, after, now, limit) {
    const r = await rows<{ id: string; user_id: string }>(db, 'SELECT id, user_id FROM user_audit WHERE id > ?1 AND id <= ?2 ORDER BY id LIMIT ?3', after, now, limit);
    return r.map((d) => ({ cursor: d.id, data: { userId: d.user_id } }));
  },
};

const users: Pass = {
  entity: 'UserV1',
  async fetch(db, _userId, after, now, limit) {
    const r = await rows<UserRow>(db, 'SELECT * FROM users WHERE update_id > ?1 AND update_id <= ?2 ORDER BY update_id LIMIT ?3', after, now, limit);
    return r.map((u) => ({ cursor: u.update_id, data: mapSyncUser(u) }));
  },
};

const assetDeletes: Pass = {
  entity: 'AssetDeleteV1',
  async fetch(db, userId, after, now, limit) {
    const r = await rows<{ id: string; asset_id: string }>(db, 'SELECT id, asset_id FROM asset_audit WHERE owner_id = ?1 AND id > ?2 AND id <= ?3 ORDER BY id LIMIT ?4', userId, after, now, limit);
    return r.map((d) => ({ cursor: d.id, data: { assetId: d.asset_id } }));
  },
};

const assets: Pass = {
  entity: 'AssetV2',
  async fetch(db, userId, after, now, limit) {
    const r = await rows<AssetRow>(db, 'SELECT * FROM assets WHERE owner_id = ?1 AND update_id > ?2 AND update_id <= ?3 ORDER BY update_id LIMIT ?4', userId, after, now, limit);
    return r.map((a) => ({ cursor: a.update_id, data: mapSyncAsset(a) }));
  },
};

const exifs: Pass = {
  entity: 'AssetExifV1',
  async fetch(db, userId, after, now, limit) {
    const r = await rows<ExifRow>(db, 'SELECT * FROM asset_exif WHERE owner_id = ?1 AND update_id > ?2 AND update_id <= ?3 ORDER BY update_id LIMIT ?4', userId, after, now, limit);
    return r.map((e) => ({ cursor: e.update_id, data: mapSyncExif(e) }));
  },
};

/** Request types in Immich's SYNC_TYPES_ORDER; each lists its passes in order. */
export const REQUEST_ORDER = ['AuthUsersV2', 'UsersV1', 'AssetsV2', 'AssetExifsV1'];
export const PASSES: Record<string, Pass[]> = {
  AuthUsersV2: [authUsers],
  UsersV1: [userDeletes, users],
  AssetsV2: [assetDeletes, assets],
  AssetExifsV1: [exifs],
};
```

- [ ] **Step 5: Implement the stream and routes**

`src/sync/routes.ts`:

```ts
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { requireAuth, type AuthContext } from '../auth/session';
import { nowCursor } from '../db/changes';
import { deleteAcks, getCheckpoints, needsReset, resetSession, setAcks } from './acks';
import { PASSES, REQUEST_ORDER } from './passes';

export const PAGE_SIZE = 500;
export const QUERY_BUDGET = 950;

const enc = new TextEncoder();
const line = (type: string, data: unknown, ack: string) => enc.encode(JSON.stringify({ type, data, ack }) + '\n');

/** Yields one encoded chunk per page, so at most one page of lines is held in memory. */
async function* generate(db: D1Database, auth: AuthContext, wanted: Set<string>, pageSize: number, budget: number) {
  if (needsReset(auth.session)) {
    yield line('SyncResetV1', {}, 'SyncResetV1|reset');
    return;
  }
  let queries = 2;
  const checkpoints = await getCheckpoints(db, auth.session.id);
  const now = await nowCursor(db);
  for (const request of REQUEST_ORDER) {
    if (!wanted.has(request)) continue;
    for (const pass of PASSES[request]) {
      let after = checkpoints.get(pass.entity) ?? '';
      for (;;) {
        if (queries >= budget) return; // close without SyncCompleteV1; the client acks what it has and the next sync resumes
        const page = await pass.fetch(db, auth.user.id, after, now, pageSize);
        queries++;
        let text = '';
        for (const row of page) text += JSON.stringify({ type: pass.entity, data: row.data, ack: `${pass.entity}|${row.cursor}` }) + '\n';
        if (text) yield enc.encode(text);
        if (page.length < pageSize) break;
        after = page[page.length - 1].cursor;
      }
    }
  }
  yield line('SyncCompleteV1', {}, `SyncCompleteV1|${now}`);
}

export function streamSync(
  db: D1Database,
  auth: AuthContext,
  types: string[],
  opts: { pageSize?: number; queryBudget?: number } = {},
): ReadableStream<Uint8Array> {
  const gen = generate(db, auth, new Set(types), opts.pageSize ?? PAGE_SIZE, opts.queryBudget ?? QUERY_BUDGET);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const r = await gen.next();
        if (r.done) controller.close();
        else controller.enqueue(r.value);
      } catch (err) {
        console.error('sync stream failed', err);
        controller.close(); // never end with an error: the client would drop unacked lines
      }
    },
    async cancel() {
      await gen.return(undefined);
    },
  });
}

export const syncRoutes = new Hono<AppEnv>();

syncRoutes.post('/sync/stream', requireAuth, async (c) => {
  const body = await c.req.json<{ types?: string[]; reset?: boolean }>();
  const auth = c.get('auth');
  if (body.reset) await resetSession(c.env.DB, auth.session.id);
  return new Response(streamSync(c.env.DB, auth, body.types ?? []), {
    headers: { 'content-type': 'application/jsonlines+json', 'cache-control': 'no-store' },
  });
});

syncRoutes.get('/sync/ack', requireAuth, async (c) => {
  const { results } = await c.env.DB.prepare('SELECT entity_type, ack FROM sync_checkpoints WHERE session_id = ?1')
    .bind(c.get('auth').session.id)
    .all<{ entity_type: string; ack: string }>();
  return c.json(results.map((r) => ({ type: r.entity_type, ack: r.ack })));
});

syncRoutes.post('/sync/ack', requireAuth, async (c) => {
  const { acks } = await c.req.json<{ acks: string[] }>();
  await setAcks(c.env.DB, c.get('auth').session.id, acks ?? []);
  return c.body(null, 204);
});

syncRoutes.delete('/sync/ack', requireAuth, async (c) => {
  const body = await c.req.json<{ types?: string[] }>().catch(() => ({}) as { types?: string[] });
  await deleteAcks(c.env.DB, c.get('auth').session.id, body.types);
  return c.body(null, 204);
});
```

The pinned spec declares 204 for `POST` and `DELETE /sync/ack`.

`needsReset` sees the session as loaded at request start; after `reset: true` that is fine because `RESET_BEFORE` is compared with `reset_at`, which `resetSession` just set to now; reload the session in the handler when `body.reset` is true so `needsReset` sees the new `reset_at`:

```ts
  if (body.reset) {
    await resetSession(c.env.DB, auth.session.id);
    auth.session.reset_at = new Date().toISOString();
  }
```

(use this block in place of the single `if (body.reset)` line above).

Modify `src/app.ts`: import `syncRoutes` and add `api.route('/', syncRoutes);`.

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run test/sync.test.ts && npm run typecheck`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Add sync stream with per-entity checkpoints, delete audits, reset and query budget"
```

---

### Task 12: Media endpoints

**Files:**
- Create: `src/media/routes.ts`
- Modify: `src/app.ts`
- Test: `test/media.test.ts`

**Interfaces:**
- Consumes: `thumbKey`, `contentTypeFor`, `extensionOf`, `requireAuth`, `AssetRow`.
- Produces: `GET /api/assets/:id/thumbnail`, `GET /api/assets/:id/original`, `GET /api/assets/:id/video/playback`; `loadOwnedAsset(c, id): Promise<AssetRow>` (404 when missing or owned by another user) exported for Task 14.

- [ ] **Step 1: Write the failing tests**

`test/media.test.ts`:

```ts
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { authHeaders, BASE, createUser, login, uploadAsset } from './helpers';

async function setup() {
  await createUser();
  const token = await login();
  const bytes = crypto.getRandomValues(new Uint8Array(10_000));
  const { body } = await uploadAsset(token, bytes);
  return { token, id: body.id, bytes };
}

describe('media', () => {
  it('missing thumbnail is 404 no-store', async () => {
    const { token, id } = await setup();
    const res = await SELF.fetch(`${BASE}/api/assets/${id}/thumbnail?size=thumbnail&edited=true`, { headers: authHeaders(token) });
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('serves thumbnail, preview and fullsize (from preview) with caching and etag', async () => {
    const { token, id } = await setup();
    await env.MEDIA.put(`thumbs/${id}/thumbnail.webp`, 'T', { httpMetadata: { contentType: 'image/webp' } });
    await env.MEDIA.put(`thumbs/${id}/preview.jpeg`, 'P', { httpMetadata: { contentType: 'image/jpeg' } });
    await env.DB.prepare('UPDATE assets SET has_thumbnail = 1').run();
    const thumb = await SELF.fetch(`${BASE}/api/assets/${id}/thumbnail`, { headers: authHeaders(token) });
    expect(await thumb.text()).toBe('T');
    expect(thumb.headers.get('content-type')).toBe('image/webp');
    expect(thumb.headers.get('cache-control')).toBe('private, max-age=86400');
    expect(thumb.headers.get('etag')).toBeTruthy();
    expect(await (await SELF.fetch(`${BASE}/api/assets/${id}/thumbnail?size=preview`, { headers: authHeaders(token) })).text()).toBe('P');
    expect(await (await SELF.fetch(`${BASE}/api/assets/${id}/thumbnail?size=fullsize`, { headers: authHeaders(token) })).text()).toBe('P');
  });

  it('serves the original with range support', async () => {
    const { token, id, bytes } = await setup();
    const full = await SELF.fetch(`${BASE}/api/assets/${id}/original`, { headers: authHeaders(token) });
    expect(full.status).toBe(200);
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(bytes);
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    const part = await SELF.fetch(`${BASE}/api/assets/${id}/original`, { headers: { ...authHeaders(token), range: 'bytes=100-199' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 100-199/10000');
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(bytes.slice(100, 200));
  });

  it('does not serve another user\'s asset', async () => {
    const { id } = await setup();
    await createUser({ email: 'other@example.com', isAdmin: false });
    const other = await login('other@example.com');
    const res = await SELF.fetch(`${BASE}/api/assets/${id}/original`, { headers: authHeaders(other) });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run test/media.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/media/routes.ts`:

```ts
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../app';
import { requireAuth } from '../auth/session';
import type { AssetRow } from '../db/rows';
import { ImmichError } from '../http/errors';
import { thumbKey } from '../process/thumbs';
import { contentTypeFor, extensionOf } from '../upload/media-types';

export const mediaRoutes = new Hono<AppEnv>();

export async function loadOwnedAsset(c: Context<AppEnv>, id: string): Promise<AssetRow> {
  const a = await c.env.DB.prepare('SELECT * FROM assets WHERE id = ?1 AND owner_id = ?2')
    .bind(id, c.get('auth').user.id)
    .first<AssetRow>();
  if (!a) throw new ImmichError(404, 'Asset not found');
  return a;
}

function objectResponse(object: R2ObjectBody | R2Object, body: ReadableStream | null, headers: Headers, rangeRequested: boolean): Response {
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('accept-ranges', 'bytes');
  if (rangeRequested && 'range' in object && object.range && 'offset' in object.range) {
    const offset = object.range.offset ?? 0;
    const length = object.range.length ?? object.size - offset;
    headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set('content-length', String(length));
    return new Response(body, { status: 206, headers });
  }
  headers.set('content-length', String(object.size));
  return new Response(body, { status: 200, headers });
}

async function serve(c: Context<AppEnv>, key: string, cacheControl: string, contentType?: string): Promise<Response> {
  const range = c.req.header('range');
  const object = await c.env.MEDIA.get(key, { range: range ? c.req.raw.headers : undefined, onlyIf: c.req.raw.headers });
  if (!object) return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
  const headers = new Headers({ 'cache-control': cacheControl });
  if (contentType) headers.set('content-type', contentType);
  if (!('body' in object)) return new Response(null, { status: 304, headers: { etag: object.httpEtag, 'cache-control': cacheControl } });
  return objectResponse(object, object.body, headers, Boolean(range));
}

mediaRoutes.get('/assets/:id/thumbnail', requireAuth, async (c) => {
  const a = await loadOwnedAsset(c, c.req.param('id'));
  if (!a.has_thumbnail) return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
  const size = c.req.query('size') === 'thumbnail' || !c.req.query('size') ? 'thumbnail' : 'preview';
  return serve(c, thumbKey(a.id, size), 'private, max-age=86400');
});

mediaRoutes.get('/assets/:id/original', requireAuth, async (c) => {
  const a = await loadOwnedAsset(c, c.req.param('id'));
  const res = await serve(c, a.original_path, 'private, max-age=86400', contentTypeFor(extensionOf(a.original_path)));
  res.headers.set('content-disposition', `inline; filename="${a.original_file_name.replace(/"/g, '')}"`);
  return res;
});

mediaRoutes.get('/assets/:id/video/playback', requireAuth, async (c) => {
  const a = await loadOwnedAsset(c, c.req.param('id'));
  if (a.type !== 'VIDEO') throw new ImmichError(400, 'Asset is not a video');
  return serve(c, a.original_path, 'private, max-age=86400', contentTypeFor(extensionOf(a.original_path)));
});
```

Thumbnail requests with `size=preview` or `size=fullsize` both map to `preview`; a missing `size` means `thumbnail`, as Immich defaults.

Modify `src/app.ts`: import `mediaRoutes` and add `api.route('/', mediaRoutes);`.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/media.test.ts && npm run typecheck`
Expected: all pass. A `Response` whose `content-type` was set by `writeHttpMetadata` is overwritten by the explicit `contentType` argument only when one is passed; that is intended.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add thumbnail, original and video playback endpoints with range support"
```

---

### Task 13: Timeline endpoints

**Files:**
- Create: `src/timeline/routes.ts`
- Modify: `src/app.ts`
- Test: `test/timeline.test.ts`

**Interfaces:**
- Consumes: `requireAuth`, `AssetRow`, `ExifRow`.
- Produces: `GET /api/timeline/buckets`, `GET /api/timeline/bucket`.

- [ ] **Step 1: Write the failing tests**

`test/timeline.test.ts`:

```ts
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { expectResponse } from './contract';
import { authHeaders, BASE, createUser, login, uploadAsset } from './helpers';
import fixtureBuckets from './fixtures/immich-3.3.0/timeline-buckets.json';

async function setup() {
  await createUser();
  const token = await login();
  const dates = ['2024-05-04T10:00:00.000Z', '2024-05-20T10:00:00.000Z', '2023-12-31T23:00:00.000Z'];
  const ids: string[] = [];
  for (const [i, d] of dates.entries()) {
    const { body } = await uploadAsset(token, crypto.getRandomValues(new Uint8Array(100 + i)), { fields: { fileCreatedAt: d, fileModifiedAt: d } });
    ids.push(body.id);
  }
  return { token, ids };
}

const get = (token: string, q: string) => SELF.fetch(`${BASE}/api/timeline/${q}`, { headers: authHeaders(token) });

describe('timeline', () => {
  it('lists month buckets newest first in Immich format', async () => {
    const { token } = await setup();
    const res = await get(token, 'buckets?visibility=timeline');
    const body = await res.json();
    expectResponse('/timeline/buckets', 'get', 200, body);
    expect(body).toEqual([
      { timeBucket: '2024-05-01', count: 2 },
      { timeBucket: '2023-12-01', count: 1 },
    ]);
    expect(Object.keys((body as any[])[0]).sort()).toEqual(Object.keys(fixtureBuckets[0]).sort());
  });

  it('returns one bucket as column arrays', async () => {
    const { token, ids } = await setup();
    const res = await get(token, 'bucket?visibility=timeline&timeBucket=2024-05-01');
    const body = (await res.json()) as Record<string, unknown[]>;
    expectResponse('/timeline/bucket', 'get', 200, body);
    expect(body.id).toEqual([ids[1], ids[0]]); // newest first
    expect(body.isImage).toEqual([true, true]);
    expect(body.isTrashed).toEqual([false, false]);
  });

  it('excludes trashed and hidden assets from the default timeline', async () => {
    const { token, ids } = await setup();
    await env.DB.prepare("UPDATE assets SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1").bind(ids[0]).run();
    await env.DB.prepare("UPDATE assets SET visibility = 'hidden' WHERE id = ?1").bind(ids[1]).run();
    expect(await (await get(token, 'buckets?visibility=timeline')).json()).toEqual([{ timeBucket: '2023-12-01', count: 1 }]);
    expect(await (await get(token, 'buckets?isTrashed=true')).json()).toEqual([{ timeBucket: '2024-05-01', count: 1 }]);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run test/timeline.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/timeline/routes.ts`:

```ts
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { requireAuth } from '../auth/session';
import { ImmichError } from '../http/errors';

export const timelineRoutes = new Hono<AppEnv>();

/** Builds the WHERE clause shared by both endpoints from Immich's TimeBucketDto query. */
function filters(q: Record<string, string>, userId: string): { sql: string; binds: unknown[] } {
  const where = ['a.owner_id = ?1'];
  const binds: unknown[] = [userId];
  if (q.isTrashed === 'true') where.push('a.deleted_at IS NOT NULL');
  else where.push('a.deleted_at IS NULL');
  if (q.visibility) {
    binds.push(q.visibility);
    where.push(`a.visibility = ?${binds.length}`);
  } else if (q.isTrashed !== 'true') {
    where.push("a.visibility IN ('timeline', 'archive')");
  }
  if (q.isFavorite === 'true') where.push('a.is_favorite = 1');
  if (q.isFavorite === 'false') where.push('a.is_favorite = 0');
  if (q.albumId || q.personId || q.tagId) where.push('0'); // albums, people and tags arrive in later phases
  return { sql: where.join(' AND '), binds };
}

timelineRoutes.get('/timeline/buckets', requireAuth, async (c) => {
  const f = filters(c.req.query(), c.get('auth').user.id);
  const order = c.req.query('order') === 'asc' ? 'ASC' : 'DESC';
  const { results } = await c.env.DB.prepare(
    `SELECT strftime('%Y-%m-01', a.local_date_time) AS timeBucket, count(*) AS count
     FROM assets a WHERE ${f.sql} GROUP BY timeBucket ORDER BY timeBucket ${order}`,
  )
    .bind(...f.binds)
    .all<{ timeBucket: string; count: number }>();
  return c.json(results);
});

timelineRoutes.get('/timeline/bucket', requireAuth, async (c) => {
  const q = c.req.query();
  if (!q.timeBucket) throw new ImmichError(400, 'timeBucket is required');
  const bucket = q.timeBucket.replace(/^[+-]/, '').slice(0, 10);
  const f = filters(q, c.get('auth').user.id);
  f.binds.push(bucket);
  const order = q.order === 'asc' ? 'ASC' : 'DESC';
  const { results } = await c.env.DB.prepare(
    `SELECT a.*, e.city, e.country, e.latitude, e.longitude, e.projection_type
     FROM assets a LEFT JOIN asset_exif e ON e.asset_id = a.id
     WHERE ${f.sql} AND strftime('%Y-%m-01', a.local_date_time) = ?${f.binds.length}
     ORDER BY a.local_date_time ${order}`,
  )
    .bind(...f.binds)
    .all<Record<string, any>>();

  const col = <T>(fn: (r: Record<string, any>) => T) => results.map(fn);
  const withCoordinates = q.withCoordinates === 'true';
  return c.json({
    id: col((r) => r.id),
    ownerId: col((r) => r.owner_id),
    createdAt: col((r) => r.created_at),
    fileCreatedAt: col((r) => r.file_created_at),
    localOffsetHours: col((r) => (Date.parse(r.local_date_time) - Date.parse(r.file_created_at)) / 3_600_000),
    duration: col((r) => r.duration),
    isFavorite: col((r) => r.is_favorite === 1),
    isImage: col((r) => r.type === 'IMAGE'),
    isTrashed: col((r) => r.deleted_at !== null),
    livePhotoVideoId: col((r) => r.live_photo_video_id),
    projectionType: col((r) => r.projection_type ?? null),
    ratio: col((r) => (r.width && r.height ? r.width / r.height : 1)),
    thumbhash: col((r) => r.thumbhash),
    visibility: col((r) => r.visibility),
    city: col((r) => r.city ?? null),
    country: col((r) => r.country ?? null),
    ...(withCoordinates ? { latitude: col((r) => r.latitude ?? null), longitude: col((r) => r.longitude ?? null) } : {}),
  });
});
```

Compare the keys of this response with `test/fixtures/immich-3.3.0/timeline-bucket.json`; if the fixture has a required key not produced here, add it with the value the fixture shows for a plain photo.

Modify `src/app.ts`: import `timelineRoutes` and add `api.route('/', timelineRoutes);`.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/timeline.test.ts && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add timeline bucket endpoints"
```

---

### Task 14: Asset viewer endpoints and stubs

**Files:**
- Create: `src/assets/map.ts`, `src/assets/routes.ts`
- Modify: `src/app.ts`
- Test: `test/assets.test.ts`

**Interfaces:**
- Consumes: `loadOwnedAsset` (Task 12), row types, `mapSyncExif` naming conventions.
- Produces: `GET /api/assets/:id` (`AssetResponseDto`); stubs `GET /api/albums` (`[]`), `GET /api/faces` (`[]`), `GET /api/assets/:id/ocr` (`[]`), plus any endpoint from `web-requests.txt` (Task 1) not otherwise implemented; `mapAssetResponse(a: AssetRow, e: ExifRow | null): Dto<'AssetResponseDto'>`.

- [ ] **Step 1: Write the failing tests**

`test/assets.test.ts`:

```ts
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { expectResponse } from './contract';
import { authHeaders, BASE, createUser, login, uploadAsset } from './helpers';

async function setup() {
  await createUser();
  const token = await login();
  const { body } = await uploadAsset(token, crypto.getRandomValues(new Uint8Array(100)));
  return { token, id: body.id };
}

describe('asset viewer', () => {
  it('GET /assets/:id matches AssetResponseDto', async () => {
    const { token, id } = await setup();
    const res = await SELF.fetch(`${BASE}/api/assets/${id}`, { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expectResponse('/assets/{id}', 'get', 200, body);
    expect(body.id).toBe(id);
  });

  it('stubs return empty arrays', async () => {
    const { token, id } = await setup();
    for (const path of [`/api/albums?assetId=${id}`, `/api/faces?id=${id}`, `/api/assets/${id}/ocr`]) {
      const res = await SELF.fetch(`${BASE}${path}`, { headers: authHeaders(token) });
      expect(res.status, path).toBe(200);
      expect(await res.json()).toEqual([]);
    }
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run test/assets.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/assets/map.ts`:

```ts
import type { AssetRow, ExifRow } from '../db/rows';
import type { Dto } from '../gen/dto';

export function mapAssetResponse(a: AssetRow, e: ExifRow | null): Dto<'AssetResponseDto'> {
  return {
    id: a.id,
    ownerId: a.owner_id,
    type: a.type,
    originalFileName: a.original_file_name,
    originalPath: a.original_path,
    originalMimeType: undefined,
    checksum: a.checksum,
    fileCreatedAt: a.file_created_at,
    fileModifiedAt: a.file_modified_at,
    localDateTime: a.local_date_time,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
    duration: a.duration,
    width: a.width,
    height: a.height,
    thumbhash: a.thumbhash,
    isFavorite: a.is_favorite === 1,
    isArchived: a.visibility === 'archive',
    isTrashed: a.deleted_at !== null,
    isOffline: false,
    isEdited: false,
    hasMetadata: e !== null,
    visibility: a.visibility,
    livePhotoVideoId: a.live_photo_video_id,
    exifInfo: e
      ? {
          make: e.make, model: e.model, lensModel: e.lens_model, exposureTime: e.exposure_time,
          fNumber: e.f_number, focalLength: e.focal_length, iso: e.iso,
          latitude: e.latitude, longitude: e.longitude, city: e.city, state: e.state, country: e.country,
          dateTimeOriginal: e.date_time_original, modifyDate: e.modify_date, timeZone: e.time_zone,
          orientation: e.orientation, rating: e.rating, description: e.description,
          exifImageWidth: e.exif_image_width, exifImageHeight: e.exif_image_height, fileSizeInByte: e.file_size_in_byte,
          profileDescription: e.profile_description, projectionType: e.projection_type,
        }
      : undefined,
  } as Dto<'AssetResponseDto'>;
}
```

Remove the `as Dto<'AssetResponseDto'>` cast once `npm run typecheck` passes without it; it is there only so the first compile shows every mismatch at once through the contract test instead of failing the build. Delete `originalMimeType: undefined` if the generated type does not declare it.

`src/assets/routes.ts`:

```ts
import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { requireAuth } from '../auth/session';
import type { ExifRow } from '../db/rows';
import { loadOwnedAsset } from '../media/routes';
import { mapAssetResponse } from './map';

export const assetRoutes = new Hono<AppEnv>();

assetRoutes.get('/assets/:id', requireAuth, async (c) => {
  const a = await loadOwnedAsset(c, c.req.param('id'));
  const e = await c.env.DB.prepare('SELECT * FROM asset_exif WHERE asset_id = ?1').bind(a.id).first<ExifRow>();
  return c.json(mapAssetResponse(a, e));
});

// Viewer side panels; real implementations arrive with albums (phase 2) and ML (phase 4).
assetRoutes.get('/albums', requireAuth, (c) => c.json([]));
assetRoutes.get('/faces', requireAuth, (c) => c.json([]));
assetRoutes.get('/assets/:id/ocr', requireAuth, (c) => c.json([]));
```

Route order matters: register `assetRoutes` after `mediaRoutes` and `uploadRoutes` in `src/app.ts` so `/assets/:id/thumbnail` and `/assets/bulk-upload-check` are not captured by `/assets/:id`. Hono matches by registration order for same-method routes; `/assets/:id` only matches one path segment, so `/assets/:id/ocr` is separate.

For each line of `test/fixtures/immich-3.3.0/web-requests.txt` whose endpoint is not implemented by Tasks 5–14, add a stub here returning the empty value of its declared response type (`[]` for arrays, the minimal valid object for objects, checked with `expectResponse` in a new test case in `test/assets.test.ts`).

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/assets.test.ts && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add asset detail endpoint and web viewer stubs"
```

---

### Task 15: Trash purge cron and backup queue

**Files:**
- Create: `src/cron/purge.ts`, `src/backup/consumer.ts`, `src/cron/index.ts`
- Modify: `src/index.ts`
- Test: `test/purge.test.ts`, `test/backup.test.ts`

**Interfaces:**
- Consumes: `tracked`, `commit`, `thumbKey`, `AssetRow`.
- Produces:
  - `purgeTrash(env: Env, now?: Date): Promise<number>` (number purged; batches of 100)
  - `BackupMessage = { assetId: string }`
  - `copyToBackup(env: Env, asset: AssetRow, fetcher?: typeof fetch): Promise<void>`
  - `handleBackupBatch(batch: MessageBatch<BackupMessage>, env: Env, fetcher?: typeof fetch): Promise<void>`
  - `requeueMissingBackups(env: Env): Promise<number>`
  - `runScheduled(cron: string, env: Env): Promise<void>`

- [ ] **Step 1: Write the failing tests**

`test/purge.test.ts`:

```ts
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { purgeTrash } from '../src/cron/purge';
import { createUser, login, uploadAsset } from './helpers';

describe('purgeTrash', () => {
  it('hard-deletes assets trashed over 30 days ago, writes audits, keeps the rest', async () => {
    await createUser();
    const token = await login();
    const old = (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(100)))).body.id;
    const recent = (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(101)))).body.id;
    const live = (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(102)))).body.id;
    await env.MEDIA.put(`thumbs/${old}/thumbnail.webp`, 'x');
    await env.DB.prepare("UPDATE assets SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1").bind(old).run();
    await env.DB.prepare("UPDATE assets SET deleted_at = '2026-03-01T00:00:00.000Z' WHERE id = ?1").bind(recent).run();
    const oldPath = await env.DB.prepare('SELECT original_path FROM assets WHERE id = ?1').bind(old).first<string>('original_path');

    expect(await purgeTrash(env, new Date('2026-03-15T00:00:00.000Z'))).toBe(1);

    const remaining = (await env.DB.prepare('SELECT id FROM assets ORDER BY id').all<{ id: string }>()).results.map((r) => r.id);
    expect(remaining.sort()).toEqual([recent, live].sort());
    expect(await env.MEDIA.head(oldPath!)).toBeNull();
    expect(await env.MEDIA.head(`thumbs/${old}/thumbnail.webp`)).toBeNull();
    const audit = await env.DB.prepare('SELECT asset_id FROM asset_audit').all<{ asset_id: string }>();
    expect(audit.results).toEqual([{ asset_id: old }]);
    expect(await env.DB.prepare('SELECT usage_bytes FROM users').first('usage_bytes')).toBe(101 + 102);
  });
});
```

`test/backup.test.ts`:

```ts
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { copyToBackup, requeueMissingBackups } from '../src/backup/consumer';
import type { AssetRow } from '../src/db/rows';
import { createUser, login, uploadAsset } from './helpers';

describe('backup', () => {
  it('copies with a signed S3 CopyObject and stamps backed_up_at', async () => {
    await createUser();
    const token = await login();
    const id = (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(100)))).body.id;
    const asset = (await env.DB.prepare('SELECT * FROM assets WHERE id = ?1').bind(id).first<AssetRow>())!;
    const seen: Request[] = [];
    const fetcher = (async (input: RequestInfo, init?: RequestInit) => {
      const req = new Request(input, init);
      seen.push(req);
      return new Response('<CopyObjectResult/>', { status: 200 });
    }) as typeof fetch;
    await copyToBackup(env, asset, fetcher);
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('PUT');
    expect(seen[0].url).toBe(`https://testacct.r2.cloudflarestorage.com/immich-originals-backup/${asset.original_path}`);
    expect(seen[0].headers.get('x-amz-copy-source')).toBe(`/immich-media/${asset.original_path}`);
    expect(seen[0].headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(await env.DB.prepare('SELECT backed_up_at FROM assets WHERE id = ?1').bind(id).first('backed_up_at')).toBeTruthy();
  });

  it('throws on a failed copy and leaves backed_up_at null', async () => {
    await createUser();
    const token = await login();
    const id = (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(100)))).body.id;
    const asset = (await env.DB.prepare('SELECT * FROM assets WHERE id = ?1').bind(id).first<AssetRow>())!;
    const fetcher = (async () => new Response('<Error/>', { status: 500 })) as typeof fetch;
    await expect(copyToBackup(env, asset, fetcher)).rejects.toThrow(/500/);
    expect(await env.DB.prepare('SELECT backed_up_at FROM assets WHERE id = ?1').bind(id).first('backed_up_at')).toBeNull();
  });

  it('re-enqueues only processed assets without a backup', async () => {
    await createUser();
    const token = await login();
    const a = (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(100)))).body.id;
    const b = (await uploadAsset(token, crypto.getRandomValues(new Uint8Array(101)))).body.id;
    await uploadAsset(token, crypto.getRandomValues(new Uint8Array(102))); // stays pending
    await env.DB.prepare("UPDATE assets SET status = 'ready' WHERE id IN (?1, ?2)").bind(a, b).run();
    await env.DB.prepare("UPDATE assets SET backed_up_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1").bind(b).run();
    expect(await requeueMissingBackups(env)).toBe(1);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run test/purge.test.ts test/backup.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement purge**

`src/cron/purge.ts`:

```ts
import { commit, tracked } from '../db/changes';
import type { AssetRow } from '../db/rows';
import { thumbKey } from '../process/thumbs';

const TRASH_DAYS = 30;
const BATCH = 100;

/** The only code path that deletes originals of assets that have rows. */
export async function purgeTrash(env: Env, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - TRASH_DAYS * 86_400_000).toISOString();
  let purged = 0;
  for (;;) {
    const { results } = await env.DB.prepare(
      'SELECT * FROM assets WHERE deleted_at IS NOT NULL AND deleted_at < ?1 ORDER BY deleted_at LIMIT ?2',
    )
      .bind(cutoff, BATCH)
      .all<AssetRow>();
    if (results.length === 0) return purged;
    await env.MEDIA.delete(results.flatMap((a) => [a.original_path, thumbKey(a.id, 'thumbnail'), thumbKey(a.id, 'preview')]));
    const deletedAt = now.toISOString();
    await commit(
      env.DB,
      results.flatMap((a) => [
        env.DB.prepare('DELETE FROM assets WHERE id = ?1').bind(a.id),
        env.DB.prepare('UPDATE users SET usage_bytes = max(0, usage_bytes - ?1) WHERE id = ?2').bind(a.file_size, a.owner_id),
        tracked('INSERT INTO asset_audit (id, asset_id, owner_id, deleted_at) VALUES (:cursor, ?1, ?2, ?3)', a.id, a.owner_id, deletedAt),
      ]),
    );
    purged += results.length;
    if (results.length < BATCH) return purged;
  }
}
```

R2 objects are deleted before the rows. If the D1 commit then fails, the next run deletes the (already missing) objects again and retries the commit; deleting a missing key is not an error in R2.

- [ ] **Step 4: Implement backup**

`src/backup/consumer.ts`:

```ts
import { AwsClient } from 'aws4fetch';
import type { AssetRow } from '../db/rows';

export interface BackupMessage {
  assetId: string;
}

const encodeKey = (key: string) => key.split('/').map(encodeURIComponent).join('/');

/** Server-side copy of the original into the backup bucket via the S3-compatible API. */
export async function copyToBackup(env: Env, asset: AssetRow, fetcher: typeof fetch = fetch): Promise<void> {
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto',
  });
  const url = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.BACKUP_BUCKET_NAME}/${encodeKey(asset.original_path)}`;
  const signed = await client.sign(url, {
    method: 'PUT',
    headers: { 'x-amz-copy-source': `/${env.MEDIA_BUCKET_NAME}/${encodeKey(asset.original_path)}` },
  });
  const res = await fetcher(signed);
  const text = await res.text();
  if (!res.ok || text.includes('<Error>')) throw new Error(`backup copy failed ${res.status}: ${text.slice(0, 300)}`);
  await env.DB.prepare('UPDATE assets SET backed_up_at = ?2 WHERE id = ?1').bind(asset.id, new Date().toISOString()).run();
}

export async function handleBackupBatch(batch: MessageBatch<BackupMessage>, env: Env, fetcher?: typeof fetch): Promise<void> {
  for (const msg of batch.messages) {
    try {
      const asset = await env.DB.prepare('SELECT * FROM assets WHERE id = ?1').bind(msg.body.assetId).first<AssetRow>();
      if (asset && !asset.backed_up_at) await copyToBackup(env, asset, fetcher);
      msg.ack();
    } catch (err) {
      console.error('backup failed', msg.body.assetId, err);
      msg.retry();
    }
  }
}

export async function requeueMissingBackups(env: Env): Promise<number> {
  const { results } = await env.DB.prepare(
    "SELECT id FROM assets WHERE backed_up_at IS NULL AND status != 'pending' AND deleted_at IS NULL LIMIT 5000",
  ).all<{ id: string }>();
  for (let i = 0; i < results.length; i += 100) {
    await env.BACKUP_QUEUE.sendBatch(results.slice(i, i + 100).map((r) => ({ body: { assetId: r.id } })));
  }
  return results.length;
}
```

`backed_up_at` is not a synced field, so this plain `UPDATE` does not go through `changes`. Objects larger than 5 GB need `UploadPartCopy`; the 100 MB upload cap in phase 1 means no such object exists yet, and the phase 3 ingest proxy plan adds it.

`src/cron/index.ts`:

```ts
import { requeueMissingBackups } from '../backup/consumer';
import { purgeTrash } from './purge';

export async function runScheduled(cron: string, env: Env): Promise<void> {
  if (cron === '17 3 * * *') await purgeTrash(env);
  if (cron === '41 4 * * 0') await requeueMissingBackups(env);
}
```

Replace `src/index.ts`:

```ts
import { app } from './app';
import { handleBackupBatch, type BackupMessage } from './backup/consumer';
import { runScheduled } from './cron';
import { handleProcessBatch } from './process/consumer';
import type { ProcessMessage } from './upload/routes';

type QueueMessage = ProcessMessage | BackupMessage;

export default {
  fetch: app.fetch,
  async queue(batch, env) {
    if (env.DISABLE_QUEUE_CONSUMERS) return batch.ackAll();
    if (batch.queue === 'asset-process') await handleProcessBatch(batch as MessageBatch<ProcessMessage>, env);
    else if (batch.queue === 'asset-backup') await handleBackupBatch(batch as MessageBatch<BackupMessage>, env);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(event.cron, env));
  },
} satisfies ExportedHandler<Env, QueueMessage>;
```

`R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` are declared in `src/gen/env.d.ts` (Task 2).

- [ ] **Step 5: Run the whole suite and typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: every test file passes.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Add trash purge cron, backup copy queue and weekly backup re-enqueue"
```

---

### Task 16: Web app hosting, end-to-end CLI test, golden sync comparison

**Files:**
- Create: `scripts/build-web.sh`, `scripts/e2e-upload.mjs`, `scripts/golden-sync.mjs`
- Modify: `package.json` (scripts)

**Interfaces:**
- Consumes: the whole Worker; the reference server from Task 1.
- Produces: `npm run build:web`, `npm run e2e`, `npm run golden`.

- [ ] **Step 1: Write the web build script**

`scripts/build-web.sh`:

```bash
#!/usr/bin/env bash
# Builds the Immich web app at the pinned commit into ./public. Runs outside the repo's src tree.
set -euo pipefail
COMMIT=cc7fd671973085baf2a0dfba4e2b0a86cab17e6c
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${TMPDIR:-/tmp}/immich-web-build"
rm -rf "$WORK" && git clone --filter=blob:none https://github.com/immich-app/immich "$WORK"
git -C "$WORK" checkout "$COMMIT"
cd "$WORK"
corepack enable
pnpm install --frozen-lockfile --filter immich-web... 
pnpm --filter immich-web build
rm -rf "$ROOT/public" && cp -R "$WORK/web/build" "$ROOT/public"
echo "web app copied to $ROOT/public"
```

```bash
chmod +x scripts/build-web.sh
npm pkg set scripts.build:web="scripts/build-web.sh"
npm run build:web
```

Expected: `public/index.html` and `public/_app/` exist. If the web package name or build output folder differs at the pinned commit, read `web/package.json` (`name`) and `web/svelte.config.js` (`adapter-static` `pages`/`assets` option) in the clone and use those values.

- [ ] **Step 2: Check the web app against `wrangler dev`**

```bash
npx wrangler d1 migrations apply immich --local
npx wrangler dev --port 8787
```

Use a browser to open `http://localhost:8787`: the register page appears; register an admin; log in; upload `test/fixtures/media/sample.jpg` through the web uploader; the timeline shows one photo with a thumbnail after the queue consumer runs (local Images binding output may differ from production; a placeholder or missing thumbnail locally is acceptable, the asset must appear); open it; the viewer shows the preview and the info panel shows the camera make. Record any `/api` 404 from the browser console; each becomes a stub in Task 14's file (add the stub, its test, and commit).

- [ ] **Step 3: Write the CLI-shaped end-to-end upload script**

`@immich/cli` authenticates with API keys (`x-api-key`), which arrive in phase 2. Until then this script sends the CLI's request shape (`bulk-upload-check` first, then multipart with `visibility` appended after the file) with a session token. Phase 2 replaces it with `npx @immich/cli upload`.

`scripts/e2e-upload.mjs`:

```js
// Uploads test/fixtures/media/* to a running `wrangler dev`, the way @immich/cli does.
// Usage: BASE=http://localhost:8787/api node scripts/e2e-upload.mjs
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE ?? 'http://localhost:8787/api';
const DIR = 'test/fixtures/media';
const json = { 'content-type': 'application/json' };

await fetch(`${BASE}/auth/admin-sign-up`, {
  method: 'POST',
  headers: json,
  body: JSON.stringify({ email: 'e2e@example.com', password: 'e2e-pass-123', name: 'E2E' }),
}); // 400 when the admin already exists; ignored

const login = await fetch(`${BASE}/auth/login`, {
  method: 'POST',
  headers: json,
  body: JSON.stringify({ email: 'e2e@example.com', password: 'e2e-pass-123' }),
});
if (login.status !== 201) throw new Error(`login ${login.status}: ${await login.text()}`);
const auth = { 'x-immich-user-token': (await login.json()).accessToken };

const files = readdirSync(DIR).map((name) => {
  const bytes = readFileSync(join(DIR, name));
  return { name, bytes, checksum: createHash('sha1').update(bytes).digest('hex') };
});

const check = await fetch(`${BASE}/assets/bulk-upload-check`, {
  method: 'POST',
  headers: { ...auth, ...json },
  body: JSON.stringify({ assets: files.map((f) => ({ id: f.name, checksum: f.checksum })) }),
});
const { results } = await check.json();
let failed = false;
for (const f of files) {
  const verdict = results.find((r) => r.id === f.name);
  if (verdict.action === 'reject') {
    console.log(`${f.name}: already uploaded as ${verdict.assetId}`);
    continue;
  }
  const form = new FormData();
  form.append('fileCreatedAt', new Date().toISOString());
  form.append('fileModifiedAt', new Date().toISOString());
  form.append('assetData', new Blob([f.bytes]), f.name);
  form.append('visibility', 'timeline');
  const res = await fetch(`${BASE}/assets`, { method: 'POST', headers: auth, body: form });
  const body = await res.text();
  console.log(`${f.name}: ${res.status} ${body}`);
  if (res.status !== 201 && res.status !== 200) failed = true;
}
process.exit(failed ? 1 : 0);
```

```bash
npm pkg set scripts.e2e="node scripts/e2e-upload.mjs"
```

Run (with `wrangler dev` from Step 2 still running): `npm run e2e`
Expected: one line per fixture file with status 201 on the first run, and "already uploaded" lines on reruns.

- [ ] **Step 4: Write the golden sync comparison**

`scripts/golden-sync.mjs`:

```js
// Compares /sync/stream output from the reference Immich (Task 1) and this Worker for the same uploads.
// Usage: REF=http://127.0.0.1:2290/api REF_TOKEN=... OURS=http://localhost:8787/api OURS_TOKEN=... node scripts/golden-sync.mjs
const types = ['AuthUsersV2', 'UsersV1', 'AssetsV2', 'AssetExifsV1'];

async function stream(base, token) {
  const r = await fetch(`${base}/sync/stream`, {
    method: 'POST',
    headers: { 'x-immich-user-token': token, 'content-type': 'application/json', accept: 'application/jsonlines+json' },
    body: JSON.stringify({ types, reset: true }),
  });
  return (await r.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const shape = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

function describe(lines) {
  const byType = new Map();
  for (const l of lines) {
    const keys = Object.fromEntries(Object.entries(l.data).map(([k, v]) => [k, shape(v)]));
    byType.set(l.type, { count: (byType.get(l.type)?.count ?? 0) + 1, keys: { ...(byType.get(l.type)?.keys ?? {}), ...keys } });
  }
  return byType;
}

const ref = describe(await stream(process.env.REF, process.env.REF_TOKEN));
const ours = describe(await stream(process.env.OURS, process.env.OURS_TOKEN));
let failed = false;
for (const [type, r] of ref) {
  const o = ours.get(type);
  if (!o) { console.log(`MISSING type ${type}`); failed = true; continue; }
  for (const [k, s] of Object.entries(r.keys)) {
    if (!(k in o.keys)) { console.log(`${type}.${k}: missing (reference ${s})`); failed = true; }
    else if (o.keys[k] !== s && o.keys[k] !== 'null' && s !== 'null') { console.log(`${type}.${k}: ${o.keys[k]} vs reference ${s}`); failed = true; }
  }
}
for (const type of ours.keys()) if (!ref.has(type)) console.log(`extra type ${type} (reference has none)`);
console.log(failed ? 'GOLDEN SYNC: DIFFERENCES' : 'GOLDEN SYNC: MATCH');
process.exit(failed ? 1 : 0);
```

```bash
npm pkg set scripts.golden="node scripts/golden-sync.mjs"
```

Run with an SSH tunnel to the reference server (`ssh -fNL 2290:127.0.0.1:2290 <build-host>`), the reference token from `~/immich-ref/token` on the build host, and a token for the local Worker where the same two sample files were uploaded (Step 3 uploads them):

```bash
REF=http://127.0.0.1:2290/api REF_TOKEN=$(ssh <build-host> cat immich-ref/token) \
OURS=http://localhost:8787/api OURS_TOKEN=<token from a login to wrangler dev> npm run golden
```

Expected: `GOLDEN SYNC: MATCH`. With `reset: true` the reference sends `SyncResetV1` only when a reset is pending; it is not pending for a fresh session, so both streams contain data lines. Fix any reported field difference in the mappers (Tasks 5 and 11) and re-run.

- [ ] **Step 5: Commit, then stop the reference server**

```bash
git add -A
git commit -m "Add web app build, CLI-shaped upload e2e script and golden sync comparison"
ssh <build-host> 'cd ~/immich-ref && docker compose down -v'
```

---

### Task 17: Deploy to staging, phone check, spec sync

**Files:**
- Modify: `wrangler.jsonc` (real D1 ID), `docs/superpowers/specs/2026-10-12-immich-cloudflare-design.md` (deviations), `README.md` (create)

**Interfaces:**
- Consumes: everything.
- Produces: a deployed Worker at `https://immich-cf.<account>.workers.dev` (staging) and the phase 1 exit check result.

- [ ] **Step 1: Create Cloudflare resources**

Confirm with the user before running these: they create billable resources on the Cloudflare account.

```bash
npx wrangler d1 create immich
npx wrangler r2 bucket create immich-media
npx wrangler r2 bucket create immich-originals-backup
npx wrangler queues create asset-process
npx wrangler queues create asset-process-dlq
npx wrangler queues create asset-backup
npx wrangler queues create asset-backup-dlq
npx wrangler r2 bucket lifecycle add immich-media abort-mpu --abort-multipart-days 1 --prefix originals/
```

Put the printed D1 `database_id` into `wrangler.jsonc`, and set `vars.R2_ACCOUNT_ID` to the account ID (`npx wrangler whoami`).

- [ ] **Step 2: Create the backup S3 token and store it**

In the Cloudflare dashboard, create an R2 API token with Object Read & Write scoped to `immich-media` and `immich-originals-backup`. Store it in your secret manager, then set the Worker secrets without printing values:

```bash
npx wrangler secret put R2_ACCESS_KEY_ID      # value from your secret manager
npx wrangler secret put R2_SECRET_ACCESS_KEY  # value from your secret manager
```

(Enter the values at the prompt; do not paste them into shell history.)

- [ ] **Step 3: Migrate and deploy**

```bash
npx wrangler d1 migrations apply immich --remote
npm run build:web
npx wrangler deploy
curl -fsS https://immich-cf.<subdomain>.workers.dev/api/server/ping
```

Expected: `{"res":"pong"}`.

- [ ] **Step 4: Phase 1 exit check on a phone**

1. Open the deployed URL in a browser, register the admin account.
2. On the iPhone, install Immich from the App Store, enter the Worker URL, log in.
3. Enable backup for one album of about 1,000 photos (videos over 100 MB will show "file too large"; that is expected in phase 1).
4. Wait for backup to finish. Check: the app timeline shows the photos with thumbnails; the web timeline shows the same count; opening a photo in both shows the preview and EXIF info.
5. Check D1: `npx wrangler d1 execute immich --remote --command "SELECT status, count(*) FROM assets GROUP BY status"`. Expected: mostly `ready`; `needs_media` for videos and RAW; `failed` count is zero or each failure's `error` is understood.
6. Check the backup bucket after the queue drains: `npx wrangler d1 execute immich --remote --command "SELECT count(*) FROM assets WHERE backed_up_at IS NULL AND status != 'pending'"` returns 0.

Record the results (counts, any failures) in `README.md` under "Phase 1 exit check".

- [ ] **Step 5: Update the spec for this plan's deviations**

Edit `docs/superpowers/specs/2026-10-12-immich-cloudflare-design.md`:
- Section 3 last paragraph: replace "TypeScript types plus Zod schemas" with "TypeScript types (openapi-typescript); tests validate responses against the OpenAPI document with an in-repo validator".
- Section 4 `assets` row: replace "`checksum` (SHA-1, 20 bytes)" with "`checksum` (SHA-1, base64 text)"; add `has_thumbnail`.
- Section 7.2 step 1: replace the MOV/MP4 sentence with "Video metadata (creation date, GPS) is read by the phase 3 `media` container; until then videos use the client's `fileCreatedAt`."
- Section 7.3: add "Phase 1 serves video playback from the original file."
- Section 10 contract bullet: replace "Zod schemas generated from" with "an in-repo validator over".

Run `python3 ~/.claude/hooks/prose-lint.py docs/superpowers/specs/2026-10-12-immich-cloudflare-design.md` and fix any hits.

- [ ] **Step 6: Write README and commit**

`README.md`:

```markdown
# immich-cf

Immich-compatible server on Cloudflare Workers, D1 and R2. Design: `docs/superpowers/specs/2026-10-12-immich-cloudflare-design.md`.

## Develop
- `npm test` — unit and integration tests (Miniflare)
- `npx wrangler d1 migrations apply immich --local && npm run dev` — local server on :8787
- `npm run build:web` — build the Immich web app at the pinned commit into `public/`
- `npm run e2e` — upload fixtures against `wrangler dev`

## Deploy
- `npx wrangler d1 migrations apply immich --remote && npx wrangler deploy`
- Secrets `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` come from the R2 API token created for the backup buckets.

## Phase 1 exit check
(results recorded on completion)
```

```bash
git add -A
git commit -m "Deploy config, README and spec updates for phase 1"
```
