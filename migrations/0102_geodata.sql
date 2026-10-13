-- Phase 4: reverse geocoding. Data: GeoNames cities500 (CC BY 4.0),
-- loaded by scripts/geodata; admin1/admin2 are stored as names.

CREATE TABLE geo_place (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  cc TEXT NOT NULL,
  admin1 TEXT,
  admin2 TEXT,
  cell INTEGER NOT NULL
);
CREATE INDEX geo_place_cell_lon ON geo_place (cell, lon, lat);
CREATE INDEX geo_place_name ON geo_place (name COLLATE NOCASE);

CREATE TABLE geo_country (code2 TEXT PRIMARY KEY, code3 TEXT, name TEXT NOT NULL);
