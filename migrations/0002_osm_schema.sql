CREATE TABLE IF NOT EXISTS osm_roads (
    osm_id bigint PRIMARY KEY,
    class text NOT NULL,
    name text,
    ref text,
    layer integer,
    tunnel boolean NOT NULL DEFAULT false,
    bridge boolean NOT NULL DEFAULT false,
    geom geometry(LineString, 3857) NOT NULL
);

CREATE INDEX IF NOT EXISTS osm_roads_geom_idx ON osm_roads USING gist (geom);
CREATE INDEX IF NOT EXISTS osm_roads_class_idx ON osm_roads (class);

CREATE TABLE IF NOT EXISTS osm_water (
    osm_id bigint PRIMARY KEY,
    class text NOT NULL,
    name text,
    geom geometry(MultiPolygon, 3857) NOT NULL
);

CREATE INDEX IF NOT EXISTS osm_water_geom_idx ON osm_water USING gist (geom);

CREATE TABLE IF NOT EXISTS osm_landuse (
    osm_id bigint PRIMARY KEY,
    class text NOT NULL,
    name text,
    geom geometry(MultiPolygon, 3857) NOT NULL
);

CREATE INDEX IF NOT EXISTS osm_landuse_geom_idx ON osm_landuse USING gist (geom);
CREATE INDEX IF NOT EXISTS osm_landuse_class_idx ON osm_landuse (class);

CREATE TABLE IF NOT EXISTS osm_buildings (
    osm_id bigint PRIMARY KEY,
    class text,
    height real,
    geom geometry(MultiPolygon, 3857) NOT NULL
);

CREATE INDEX IF NOT EXISTS osm_buildings_geom_idx ON osm_buildings USING gist (geom);

CREATE TABLE IF NOT EXISTS osm_places (
    osm_id bigint PRIMARY KEY,
    class text NOT NULL,
    name text NOT NULL,
    population integer,
    geom geometry(Point, 3857) NOT NULL
);

CREATE INDEX IF NOT EXISTS osm_places_geom_idx ON osm_places USING gist (geom);
CREATE INDEX IF NOT EXISTS osm_places_class_idx ON osm_places (class);

CREATE TABLE IF NOT EXISTS osm_boundaries (
    osm_id bigint PRIMARY KEY,
    admin_level integer,
    name text,
    geom geometry(MultiLineString, 3857) NOT NULL
);

CREATE INDEX IF NOT EXISTS osm_boundaries_geom_idx ON osm_boundaries USING gist (geom);

CREATE MATERIALIZED VIEW IF NOT EXISTS gen_water_z0_5 AS
SELECT
    osm_id,
    class,
    name,
    ST_Multi(ST_SimplifyPreserveTopology(geom, 8000))::geometry(MultiPolygon, 3857) AS geom
FROM osm_water
WHERE ST_Area(geom) > 10000000;

CREATE INDEX IF NOT EXISTS gen_water_z0_5_geom_idx ON gen_water_z0_5 USING gist (geom);

CREATE MATERIALIZED VIEW IF NOT EXISTS gen_water_z6_8 AS
SELECT
    osm_id,
    class,
    name,
    ST_Multi(ST_SimplifyPreserveTopology(geom, 1500))::geometry(MultiPolygon, 3857) AS geom
FROM osm_water
WHERE ST_Area(geom) > 1000000;

CREATE INDEX IF NOT EXISTS gen_water_z6_8_geom_idx ON gen_water_z6_8 USING gist (geom);
