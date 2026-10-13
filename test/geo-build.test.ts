import { describe, expect, it } from 'vitest';
import { byteLength, cellOf, groupStatements, insertStatements, parseAdminNames, parseCities, parseCountryInfo, PREPARE_SQL, sqlValue, SWAP_SQL } from '../scripts/geodata/lib.mjs';

const row = (id: number, name: string, lat: number, lon: number, feature: string, cc: string, a1: string, a2: string) =>
  [id, name, name, '', lat, lon, 'P', feature, cc, '', a1, a2, '', '', 0, '', 0, 'UTC', '2020-01-01'].join('\t');

describe('geodata build helpers', () => {
  const admin1 = parseAdminNames('CH.ZH\tZurich\tZurich\t2657895\nAU.02\tVictoria\tVictoria\t1');
  const admin2 = parseAdminNames('CH.ZH.112\tBezirk Zurich\tBezirk Zurich\t7');

  it('maps cities with admin names and the latitude cell, and filters like Immich', () => {
    const text = [
      row(1, "Val d'Or", 47.3667, 8.55, 'PPLA', 'CH', 'ZH', '112'),
      row(2, 'Hidden', 10, 10, 'PPLH', 'CH', 'ZH', ''),
      row(3, 'Suburb', 1, 1, 'PPLX', 'CH', 'ZH', ''),
      row(4, 'AU Suburb', -37.8, 144.9, 'PPLX', 'AU', '02', ''),
      '',
    ].join('\n');
    const rows = [...parseCities(text, admin1, admin2)];
    expect(rows.map((r) => r.id)).toEqual([1, 4]);
    expect(rows[0]).toEqual({ id: 1, name: "Val d'Or", lat: 47.3667, lon: 8.55, cc: 'CH', admin1: 'Zurich', admin2: 'Bezirk Zurich', cell: 549 });
    expect(rows[1]).toMatchObject({ admin1: 'Victoria', admin2: null });
    expect(cellOf(-90)).toBe(0);
  });

  it('parses country info, skipping comments', () => {
    const text = '#ISO\tISO3\n#more\nCH\tCHE\t756\tSZ\tSwitzerland\tBern\n';
    expect(parseCountryInfo(text)).toEqual([{ code2: 'CH', code3: 'CHE', name: 'Switzerland' }]);
  });

  it('escapes quotes and writes statements under the size cap', () => {
    expect(sqlValue("Val d'Or")).toBe("'Val d''Or'");
    expect(sqlValue(null)).toBe('NULL');
    const rows = Array.from({ length: 500 }, (_, i) => ({ id: i, name: `Place ${i}` }));
    const statements = insertStatements('geo_place', ['id', 'name'], rows, 1000);
    expect(statements.length).toBeGreaterThan(1);
    for (const s of statements) expect(s.length).toBeLessThanOrEqual(1000);
    expect(statements.join('').match(/Place \d+/g)).toHaveLength(500);
    expect(groupStatements(statements, 3000).length).toBeGreaterThan(1);
  });
});

describe('import swap', () => {
  it('counts statement size in bytes, not characters', () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: i, name: '東京'.repeat(10) }));
    for (const s of insertStatements('t', ['id', 'name'], rows, 1000)) expect(byteLength(s)).toBeLessThanOrEqual(1000);
  });

  it('loads under new names and swaps in with the final index names', () => {
    expect(PREPARE_SQL.join('\n')).toContain('CREATE TABLE geo_place_new');
    expect(SWAP_SQL.join('\n')).toContain('ALTER TABLE geo_place_new RENAME TO geo_place');
    for (const name of ['geo_place_cell_lon', 'geo_place_name', 'geo_place_admin1', 'geo_place_admin2']) expect(SWAP_SQL.join('\n')).toContain(`CREATE INDEX ${name} `);
  });
});
