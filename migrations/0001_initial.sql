CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE import_source_type AS ENUM ('local_path', 'url');
CREATE TYPE import_mode AS ENUM ('replace');
CREATE TYPE import_job_state AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');

CREATE TABLE import_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    import_name text NOT NULL,
    source_type import_source_type NOT NULL,
    source_value text NOT NULL,
    mode import_mode NOT NULL DEFAULT 'replace',
    state import_job_state NOT NULL DEFAULT 'queued',
    progress_message text,
    log_tail text NOT NULL DEFAULT '',
    error_message text,
    cancel_requested boolean NOT NULL DEFAULT false,
    started_at timestamptz,
    finished_at timestamptz,
    heartbeat_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX import_jobs_state_created_at_idx ON import_jobs (state, created_at);
CREATE INDEX import_jobs_import_name_created_at_idx ON import_jobs (import_name, created_at DESC);

CREATE TABLE osm_roads (
    import_name text NOT NULL,
    osm_id bigint NOT NULL,
    class text NOT NULL,
    name text,
    ref text,
    layer integer,
    tunnel boolean NOT NULL DEFAULT false,
    bridge boolean NOT NULL DEFAULT false,
    tags jsonb NOT NULL DEFAULT '{}'::jsonb,
    geom geometry(LineString, 3857) NOT NULL,
    PRIMARY KEY (import_name, osm_id)
);

CREATE INDEX osm_roads_geom_idx ON osm_roads USING gist (geom);
CREATE INDEX osm_roads_class_idx ON osm_roads (class);

CREATE TABLE osm_water (
    import_name text NOT NULL,
    osm_id bigint NOT NULL,
    class text NOT NULL,
    name text,
    tags jsonb NOT NULL DEFAULT '{}'::jsonb,
    geom geometry(MultiPolygon, 3857) NOT NULL,
    PRIMARY KEY (import_name, osm_id)
);

CREATE INDEX osm_water_geom_idx ON osm_water USING gist (geom);

CREATE TABLE osm_landuse (
    import_name text NOT NULL,
    osm_id bigint NOT NULL,
    class text NOT NULL,
    name text,
    tags jsonb NOT NULL DEFAULT '{}'::jsonb,
    geom geometry(MultiPolygon, 3857) NOT NULL,
    PRIMARY KEY (import_name, osm_id)
);

CREATE INDEX osm_landuse_geom_idx ON osm_landuse USING gist (geom);
CREATE INDEX osm_landuse_class_idx ON osm_landuse (class);

CREATE TABLE osm_buildings (
    import_name text NOT NULL,
    osm_id bigint NOT NULL,
    class text,
    name text,
    house_number text,
    height real,
    tags jsonb NOT NULL DEFAULT '{}'::jsonb,
    geom geometry(MultiPolygon, 3857) NOT NULL,
    PRIMARY KEY (import_name, osm_id)
);

CREATE INDEX osm_buildings_geom_idx ON osm_buildings USING gist (geom);

CREATE TABLE osm_addresses (
    import_name text NOT NULL,
    osm_id bigint NOT NULL,
    name text,
    house_number text NOT NULL,
    street text,
    unit text,
    suburb text,
    city text,
    state text,
    postcode text,
    country text,
    tags jsonb NOT NULL DEFAULT '{}'::jsonb,
    geom geometry(Point, 3857) NOT NULL,
    PRIMARY KEY (import_name, osm_id)
);

CREATE INDEX osm_addresses_geom_idx ON osm_addresses USING gist (geom);
CREATE INDEX osm_addresses_house_number_idx ON osm_addresses (house_number);

CREATE TABLE osm_places (
    import_name text NOT NULL,
    osm_id bigint NOT NULL,
    class text NOT NULL,
    name text NOT NULL,
    population integer,
    tags jsonb NOT NULL DEFAULT '{}'::jsonb,
    geom geometry(Point, 3857) NOT NULL,
    PRIMARY KEY (import_name, osm_id)
);

CREATE INDEX osm_places_geom_idx ON osm_places USING gist (geom);
CREATE INDEX osm_places_class_idx ON osm_places (class);

CREATE TABLE osm_pois (
    import_name text NOT NULL,
    osm_id bigint NOT NULL,
    source text NOT NULL,
    class text NOT NULL,
    name text NOT NULL,
    tags jsonb NOT NULL DEFAULT '{}'::jsonb,
    geom geometry(Point, 3857) NOT NULL,
    PRIMARY KEY (import_name, osm_id)
);

CREATE INDEX osm_pois_geom_idx ON osm_pois USING gist (geom);
CREATE INDEX osm_pois_source_class_idx ON osm_pois (source, class);

CREATE TABLE osm_boundaries (
    import_name text NOT NULL,
    osm_id bigint NOT NULL,
    admin_level integer,
    name text,
    tags jsonb NOT NULL DEFAULT '{}'::jsonb,
    geom geometry(MultiLineString, 3857) NOT NULL,
    PRIMARY KEY (import_name, osm_id)
);

CREATE INDEX osm_boundaries_geom_idx ON osm_boundaries USING gist (geom);

CREATE TABLE osm_admin_areas (
    import_name text NOT NULL,
    osm_id bigint NOT NULL,
    admin_level integer,
    name text,
    tags jsonb NOT NULL DEFAULT '{}'::jsonb,
    geom geometry(MultiPolygon, 3857) NOT NULL,
    PRIMARY KEY (import_name, osm_id)
);

CREATE INDEX osm_admin_areas_geom_idx ON osm_admin_areas USING gist (geom);
CREATE INDEX osm_admin_areas_admin_level_idx ON osm_admin_areas (admin_level);

CREATE MATERIALIZED VIEW gen_water_z0_5 AS
SELECT
    import_name,
    osm_id,
    class,
    name,
    tags,
    ST_Multi(ST_SimplifyPreserveTopology(geom, 8000))::geometry(MultiPolygon, 3857) AS geom
FROM osm_water
WHERE ST_Area(geom) > 10000000;

CREATE INDEX gen_water_z0_5_geom_idx ON gen_water_z0_5 USING gist (geom);

CREATE MATERIALIZED VIEW gen_water_z6_8 AS
SELECT
    import_name,
    osm_id,
    class,
    name,
    tags,
    ST_Multi(ST_SimplifyPreserveTopology(geom, 1500))::geometry(MultiPolygon, 3857) AS geom
FROM osm_water
WHERE ST_Area(geom) > 1000000;

CREATE INDEX gen_water_z6_8_geom_idx ON gen_water_z6_8 USING gist (geom);
