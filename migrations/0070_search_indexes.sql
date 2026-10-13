-- stream G: indexes for metadata search, suggestions and map markers.
CREATE INDEX IF NOT EXISTS assets_owner_file_created ON assets (owner_id, file_created_at);
CREATE INDEX IF NOT EXISTS assets_owner_created ON assets (owner_id, created_at);
CREATE INDEX IF NOT EXISTS asset_exif_owner_city ON asset_exif (owner_id, city);
CREATE INDEX IF NOT EXISTS asset_exif_owner_place ON asset_exif (owner_id, country, state, city);
CREATE INDEX IF NOT EXISTS asset_exif_owner_camera ON asset_exif (owner_id, make, model);
CREATE INDEX IF NOT EXISTS asset_exif_owner_lens ON asset_exif (owner_id, lens_model);
CREATE INDEX IF NOT EXISTS asset_exif_owner_geo ON asset_exif (owner_id, latitude, longitude) WHERE latitude IS NOT NULL;
