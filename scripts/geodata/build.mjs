#!/usr/bin/env node
// Downloads GeoNames data and writes chunked SQL for geo_place / geo_country into scripts/geodata/out/ (gitignored).
// Usage: node scripts/geodata/build.mjs   (needs network and the `unzip` command; see README.md)
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { groupStatements, insertStatements, parseAdminNames, parseCities, parseCountryInfo, PREPARE_SQL, SWAP_SQL } from './lib.mjs';

const BASE = 'https://download.geonames.org/export/dump';
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');
const raw = path.join(out, 'raw');
const sql = path.join(out, 'sql');

async function download(name) {
  const res = await fetch(`${BASE}/${name}`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const file = path.join(raw, name);
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

await mkdir(raw, { recursive: true });
await mkdir(sql, { recursive: true });

const zip = await download('cities500.zip');
const cities = execFileSync('unzip', ['-p', zip, 'cities500.txt'], { maxBuffer: 256 * 1024 * 1024 }).toString('utf8');
const admin1 = parseAdminNames(await readFile(await download('admin1CodesASCII.txt'), 'utf8'));
const admin2 = parseAdminNames(await readFile(await download('admin2Codes.txt'), 'utf8'));
const countries = parseCountryInfo(await readFile(await download('countryInfo.txt'), 'utf8'));

const placeRows = [...parseCities(cities, admin1, admin2)];
const placeStatements = insertStatements('geo_place_new', ['id', 'name', 'lat', 'lon', 'cc', 'admin1', 'admin2', 'cell'], placeRows);
const countryStatements = insertStatements('geo_country_new', ['code2', 'code3', 'name'], countries);

const header = '-- Data from GeoNames (https://www.geonames.org), licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).\n';
// 000 creates geo_place_new / geo_country_new (the live tables stay untouched), the middle files load them, and the
// last file swaps them in. Import in name order.
const files = [[...PREPARE_SQL, ...countryStatements], ...groupStatements(placeStatements), SWAP_SQL];
for (const [i, statements] of files.entries()) {
  await writeFile(path.join(sql, `${String(i).padStart(3, '0')}.sql`), `${header}${statements.join('\n')}\n`);
}
await writeFile(path.join(out, 'geodata-date.txt'), `${new Date().toISOString()}\n`);
console.log(`${placeRows.length} places, ${countries.length} countries, ${files.length} SQL files in ${sql}`);
