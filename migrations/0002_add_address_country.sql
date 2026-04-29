ALTER TABLE osm_addresses
ADD COLUMN IF NOT EXISTS country text;

CREATE TABLE IF NOT EXISTS osm_admin_areas (
    osm_id bigint PRIMARY KEY,
    admin_level integer,
    name text,
    geom geometry(MultiPolygon, 3857) NOT NULL
);

CREATE INDEX IF NOT EXISTS osm_admin_areas_geom_idx ON osm_admin_areas USING gist (geom);
CREATE INDEX IF NOT EXISTS osm_admin_areas_admin_level_idx ON osm_admin_areas (admin_level);
