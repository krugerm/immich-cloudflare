-- Prefix search on state and county names for GET /search/places (name already has geo_place_name).
CREATE INDEX geo_place_admin1 ON geo_place (admin1 COLLATE NOCASE);
CREATE INDEX geo_place_admin2 ON geo_place (admin2 COLLATE NOCASE);
