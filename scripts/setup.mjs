#!/usr/bin/env node
// Creates what `wrangler deploy` does not create by itself, using the names in the wrangler config:
// - every queue the config names (producers, consumers and dead-letter queues);
// - the Vectorize indexes of the CLIP_INDEX and FACE_INDEX bindings and their metadata indexes, which must exist
//   before the first vector is written (Vectorize only indexes metadata on vectors written after the index exists).
// Existing resources are left as they are, so this runs before every deploy. `-c <config>` is forwarded to wrangler.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { experimental_readRawConfig } from 'wrangler';

const args = process.argv.slice(2);
const at = args.findIndex((a) => a === '-c' || a === '--config');
const configPath = resolve(at >= 0 ? args[at + 1] : 'wrangler.jsonc');
const { rawConfig } = experimental_readRawConfig({ config: configPath });

function ensure(label, cmd) {
  const res = spawnSync('npx', ['wrangler', ...cmd, ...args], { encoding: 'utf8' });
  if (res.status === 0) return console.log(`setup: created ${label}`);
  const out = `${res.stdout}\n${res.stderr}`;
  if (/already exists|already taken|duplicate/i.test(out)) return console.log(`setup: ${label} exists`);
  console.error(out);
  throw new Error(`setup: could not create ${label}`);
}

const queues = new Set();
for (const p of rawConfig.queues?.producers ?? []) queues.add(p.queue);
for (const c of rawConfig.queues?.consumers ?? []) {
  queues.add(c.queue);
  if (c.dead_letter_queue) queues.add(c.dead_letter_queue);
}
for (const q of queues) ensure(`queue ${q}`, ['queues', 'create', q]);

const indexName = (binding) => {
  const name = rawConfig.vectorize?.find((v) => v.binding === binding)?.index_name;
  if (!name) throw new Error(`setup: no vectorize binding ${binding} in ${configPath}`);
  return name;
};
const clip = indexName('CLIP_INDEX');
const faces = indexName('FACE_INDEX');
ensure(`index ${clip}`, ['vectorize', 'create', clip, '--dimensions=768', '--metric=cosine']);
ensure(`index ${faces}`, ['vectorize', 'create', faces, '--dimensions=512', '--metric=cosine']);
ensure(`metadata index ${clip}.ownerId`, ['vectorize', 'create-metadata-index', clip, '--propertyName=ownerId', '--type=string']);
ensure(`metadata index ${faces}.assigned`, ['vectorize', 'create-metadata-index', faces, '--propertyName=assigned', '--type=string']);
