// Pure helpers for build.mjs: GeoNames parsing and SQL chunking. No I/O.

/** admin1CodesASCII.txt / admin2Codes.txt: "CC.A1[.A2]<TAB>name<TAB>ascii name<TAB>geonameid" to a Map of code to name. */
export function parseAdminNames(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    const cols = line.split('\t');
    if (cols.length >= 2 && cols[0]) map.set(cols[0], cols[1]);
  }
  return map;
}

/** countryInfo.txt: "#" comments, then ISO, ISO3, ISO-numeric, fips, country name, ... */
export function parseCountryInfo(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const cols = line.split('\t');
    if (cols[0] && cols[1] && cols[4]) rows.push({ code2: cols[0], code3: cols[1], name: cols[4] });
  }
  return rows;
}

/** 0.25 degree latitude band, the index geo_place.cell uses (see migrations/0102_geodata.sql). */
export const cellOf = (lat) => Math.floor((lat + 90) * 4);

/**
 * cities500.txt rows, filtered as Immich does (feature class PPLX is kept only in Australia, PPLH is dropped).
 * Columns: id=0 name=1 lat=4 lon=5 featureCode=7 country=8 admin1=10 admin2=11.
 */
export function* parseCities(text, admin1, admin2) {
  for (const line of text.split('\n')) {
    if (!line) continue;
    const c = line.split('\t');
    const feature = c[7];
    const cc = c[8];
    if ((feature === 'PPLX' && cc !== 'AU') || feature === 'PPLH') continue;
    const lat = Number(c[4]);
    const lon = Number(c[5]);
    if (!c[0] || !c[1] || !cc || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    yield {
      id: Number(c[0]),
      name: c[1],
      lat,
      lon,
      cc,
      admin1: admin1.get(`${cc}.${c[10]}`) ?? null,
      admin2: admin2.get(`${cc}.${c[10]}.${c[11]}`) ?? null,
      cell: cellOf(lat),
    };
  }
}

export const sqlValue = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replaceAll("'", "''")}'`);

/** Multi-row INSERT statements, each at most maxBytes (D1 allows 100 KB per statement; literals avoid the 100-parameter cap). */
const encoder = new TextEncoder();
export const byteLength = (s) => encoder.encode(s).length;

export function insertStatements(table, columns, rows, maxBytes = 90_000) {
  const head = `INSERT INTO ${table} (${columns.join(', ')}) VALUES\n`;
  const out = [];
  let tuples = [];
  let size = byteLength(head);
  const flush = () => {
    if (tuples.length) out.push(`${head}${tuples.join(',\n')};`);
    tuples = [];
    size = byteLength(head);
  };
  for (const row of rows) {
    const tuple = `(${columns.map((c) => sqlValue(row[c])).join(', ')})`;
    const bytes = byteLength(tuple) + 2; // ",\n"
    if (size + bytes + 1 > maxBytes) flush(); // +1 for ";"
    tuples.push(tuple);
    size += bytes;
  }
  flush();
  return out;
}

/** Groups statements into files of about maxBytes each. */
export function groupStatements(statements, maxBytes = 3_000_000) {
  const files = [];
  let cur = [];
  let size = 0;
  for (const s of statements) {
    if (size + byteLength(s) > maxBytes && cur.length) {
      files.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(s);
    size += byteLength(s) + 1;
  }
  if (cur.length) files.push(cur);
  return files;
}

/** Tables are loaded under new names and swapped in, so lookups never see an empty table. Keep in step with migrations 0102 and 0140. */
export const PREPARE_SQL = [
  'DROP TABLE IF EXISTS geo_place_new;',
  'DROP TABLE IF EXISTS geo_country_new;',
  `CREATE TABLE geo_place_new (id INTEGER PRIMARY KEY, name TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, cc TEXT NOT NULL, admin1 TEXT, admin2 TEXT, cell INTEGER NOT NULL);`,
  'CREATE TABLE geo_country_new (code2 TEXT PRIMARY KEY, code3 TEXT, name TEXT NOT NULL);',
];

/** Final file: replace the live tables, then build the indexes under their final names (index names are global, so they cannot exist before the old table is gone). */
export const SWAP_SQL = [
  'DROP TABLE geo_place;',
  'DROP TABLE geo_country;',
  'ALTER TABLE geo_place_new RENAME TO geo_place;',
  'ALTER TABLE geo_country_new RENAME TO geo_country;',
  'CREATE INDEX geo_place_cell_lon ON geo_place (cell, lon, lat);',
  'CREATE INDEX geo_place_name ON geo_place (name COLLATE NOCASE);',
  'CREATE INDEX geo_place_admin1 ON geo_place (admin1 COLLATE NOCASE);',
  'CREATE INDEX geo_place_admin2 ON geo_place (admin2 COLLATE NOCASE);',
];
