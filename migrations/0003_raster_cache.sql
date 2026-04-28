CREATE TABLE raster_tile_blobs (
    render_hash bytea PRIMARY KEY,
    png bytea NOT NULL,
    byte_size bigint NOT NULL,
    access_count bigint NOT NULL DEFAULT 0,
    last_accessed_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX raster_tile_blobs_last_accessed_at_idx ON raster_tile_blobs (last_accessed_at);

CREATE TABLE raster_tile_refs (
    version bigint NOT NULL,
    z integer NOT NULL,
    x integer NOT NULL,
    y integer NOT NULL,
    style_version integer NOT NULL,
    mvt_hash bytea NOT NULL,
    render_hash bytea NOT NULL REFERENCES raster_tile_blobs(render_hash) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (version, z, x, y, style_version)
);

CREATE INDEX raster_tile_refs_render_hash_idx ON raster_tile_refs (render_hash);
CREATE INDEX raster_tile_refs_mvt_hash_idx ON raster_tile_refs (mvt_hash);
