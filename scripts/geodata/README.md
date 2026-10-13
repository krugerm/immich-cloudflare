# GeoNames import

`build.mjs` downloads GeoNames `cities500`, `admin1CodesASCII`, `admin2Codes` and `countryInfo` at run time and writes SQL for the
`geo_place` and `geo_country` tables (migration `0102_geodata.sql`) into `scripts/geodata/out/`, which is gitignored. Downloaded data
is never committed.

```
node scripts/geodata/build.mjs          # needs network and `unzip`
for f in scripts/geodata/out/sql/*.sql; do
  npx wrangler d1 execute <database> --remote --file "$f"   # in name order; 000.sql clears the old rows first
done
```

Run order: import every file in name order. `000.sql` creates `geo_place_new` and `geo_country_new` (dropping leftovers from an
aborted run) and loads the countries, `001.sql` onward load the places into `geo_place_new`, and the last file swaps them in
(`DROP TABLE geo_place`, `ALTER TABLE ... RENAME`, then creates the indexes under their final names). The live tables keep serving
until the last file; during the swap the rows are present but unindexed for a short time, so lookups are slow rather than empty.
If a run aborts, start again from `000.sql`. Afterwards call `backfillPlaces` for assets processed before the import.

The import is about 230,000 rows in files of about 3 MB, with statements under 90 KB (counted in bytes). Each row costs one D1 write
for the table and one per index (four indexes), so it needs a paid D1 plan or several days on the free one. Keep the schema in
`lib.mjs` (`PREPARE_SQL`, `SWAP_SQL`) in step with migrations `0102` and `0140`.

## Attribution

Place and country names come from GeoNames (https://www.geonames.org), licensed under CC BY 4.0
(https://creativecommons.org/licenses/by/4.0/). Time zones come from `@photostructure/tz-lookup` (CC0), whose boundary data derives
from timezone-boundary-builder (ODbL).

## Not covered

Immich falls back to a Natural Earth country polygon when no city lies within 25 km. This build has no polygon table: a point farther
than 25 km from any `cities500` place gets no country.
