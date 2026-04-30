CREATE TABLE osm_transit_routes (
    import_name text NOT NULL,
    osm_id bigint NOT NULL,
    class text NOT NULL,
    name text,
    ref text,
    colour text,
    tags jsonb NOT NULL DEFAULT '{}'::jsonb,
    geom geometry(MultiLineString, 3857) NOT NULL,
    PRIMARY KEY (import_name, osm_id)
);

CREATE INDEX osm_transit_routes_geom_idx ON osm_transit_routes USING gist (geom);
CREATE INDEX osm_transit_routes_class_idx ON osm_transit_routes (class);
