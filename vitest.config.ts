import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { experimental_readRawConfig } from 'wrangler';

/**
 * Tests run against wrangler.jsonc minus its `containers` block, written to .wrangler/vitest/. Wrangler validates
 * that the container image path exists and the image needs Docker to build; tests use neither. The MEDIA_CONTAINER
 * Durable Object binding stays, so `env.MEDIA_CONTAINER` exists, but tests never start an instance. Relative paths
 * become absolute because the copy lives in another directory.
 */
async function testWranglerConfig(): Promise<string> {
  const root = process.cwd();
  const { rawConfig } = experimental_readRawConfig({ config: path.join(root, 'wrangler.jsonc') });
  const config = structuredClone(rawConfig) as Record<string, any>;
  delete config.containers;
  delete config.vectorize; // phase 4: tests use the in-memory store (TEST_FAKE_VECTORS)
  delete config.$schema;
  if (config.main) config.main = path.resolve(root, config.main);
  if (config.assets?.directory) config.assets.directory = path.resolve(root, config.assets.directory);
  for (const db of config.d1_databases ?? []) {
    if (db.migrations_dir) db.migrations_dir = path.resolve(root, db.migrations_dir);
  }
  const dir = path.join(root, '.wrangler', 'vitest');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'wrangler.json');
  await writeFile(file, JSON.stringify(config, null, 2));
  return file;
}

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  const configPath = await testWranglerConfig();
  return {
    plugins: [
      {
        name: 'arraybuffer-loader',
        enforce: 'pre' as const,
        async load(id: string) {
          if (!id.endsWith('?arraybuffer')) return null;
          const { readFile } = await import('node:fs/promises');
          const b64 = (await readFile(id.slice(0, -'?arraybuffer'.length))).toString('base64');
          return `const s = atob(${JSON.stringify(b64)}); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); export default u.buffer;`;
        },
      },
      cloudflareTest({
        wrangler: { configPath },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // Tests call consumers directly; background delivery would race with assertions.
            DISABLE_QUEUE_CONSUMERS: 'true',
            MEDIA_GRANT_SECRET: 'test-media-grant-secret',
            TEST_FAKE_VECTORS: 'true',
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
    },
  };
});
