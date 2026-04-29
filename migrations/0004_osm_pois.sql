CREATE TABLE IF NOT EXISTS osm_pois (
    osm_id bigint PRIMARY KEY,
    source text NOT NULL,
    class text NOT NULL,
    name text NOT NULL,
    geom geometry(Point, 3857) NOT NULL
);

CREATE INDEX IF NOT EXISTS osm_pois_geom_idx ON osm_pois USING gist (geom);
CREATE INDEX IF NOT EXISTS osm_pois_source_class_idx ON osm_pois (source, class);
