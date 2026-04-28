CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE import_source_type AS ENUM ('local_path', 'url');
CREATE TYPE import_mode AS ENUM ('replace');
CREATE TYPE import_job_state AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');

CREATE TABLE import_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
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

CREATE TABLE tile_versions (
    id boolean PRIMARY KEY DEFAULT true,
    version bigint NOT NULL DEFAULT 1,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT tile_versions_singleton CHECK (id)
);

INSERT INTO tile_versions (id, version)
VALUES (true, 1)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE tile_cache (
    version bigint NOT NULL,
    z integer NOT NULL,
    x integer NOT NULL,
    y integer NOT NULL,
    mvt bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (version, z, x, y)
);

CREATE INDEX tile_cache_created_at_idx ON tile_cache (created_at);
