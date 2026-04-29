# tileme

Low-memory, self-hosted OSM vector tile server.

The service is one Rust process. It serves Mapbox Vector Tiles from PostGIS, manages import jobs in Postgres, and runs `osm2pgsql` as a child process for `.osm.pbf` imports.

## Run PostGIS

```sh
podman compose up -d postgis
```

or:

```sh
podman run --name tileme-postgis --replace -d \
  --cgroup-manager=cgroupfs \
  -e POSTGRES_USER=tileme \
  -e POSTGRES_PASSWORD=tileme \
  -e POSTGRES_DB=tileme \
  -p 55432:5432 \
  docker.io/postgis/postgis:16-3.5
```

## Run the server

```sh
export DATABASE_URL=postgres://tileme:tileme@127.0.0.1:55432/tileme
cargo run
```

The same settings can be supplied as command-line flags:

```sh
cargo run -- \
  --database-url postgres://tileme:tileme@127.0.0.1:55432/tileme
```

Useful endpoints:

```text
GET  /healthz
GET  /readyz
GET  /metrics
GET  /tiles.json
GET  /tiles/{z}/{x}/{y}.pbf
POST /imports
GET  /imports
GET  /imports/{job_id}
POST /imports/{job_id}/cancel
```

## Frontend

The React/MapLibre frontend lives in `frontend/`.

For development, run Vite on `127.0.0.1:4000`, then run the Rust server on
`127.0.0.1:3000`. Debug builds proxy frontend requests from the Rust server to
Vite, so frontend changes do not require rebuilding the Rust binary.

```sh
cd frontend
export PATH=/home/linuxbrew/.linuxbrew/bin:$PATH
npm install
npm run dev
```

Then, from the repository root:

```sh
export DATABASE_URL=postgres://tileme:tileme@127.0.0.1:55432/tileme
cargo run
```

Set `TILEME_DEBUG_VITE_ORIGIN` if Vite is running somewhere other than
`http://127.0.0.1:4000`. For production, build the frontend before compiling the
Rust binary:

```sh
cd frontend
npm install
npm run build
cd ..
cargo build --release
```

The Rust binary embeds `frontend/dist` and serves it from `/`.

## Import OSM

Install `osm2pgsql` on the host and make sure it is on `PATH`, or set:

```sh
export TILEME_OSM2PGSQL_BIN=/path/to/osm2pgsql
```

Create an import from a local path:

```sh
curl -X POST http://127.0.0.1:3000/imports \
  -H 'content-type: application/json' \
  -d '{"source":{"type":"local_path","path":"/data/osm/australia-latest.osm.pbf"},"mode":"replace"}'
```

Create an import from a URL:

```sh
curl -X POST http://127.0.0.1:3000/imports \
  -H 'content-type: application/json' \
  -d '{"source":{"type":"url","url":"https://download.geofabrik.de/australia-oceania/australia-latest.osm.pbf"},"mode":"replace"}'
```

Import jobs are persistent in Postgres. On startup, any job left in `running` is marked `failed`; restart/resume is intentionally simple.

## Configuration

Configuration is managed by `clap`; every setting can be provided as a CLI flag or by environment variable.

| Flag | Environment | Default |
| --- | --- | --- |
| `--database-url` | `DATABASE_URL` | required |
| `--listen-addr` | `TILEME_LISTEN_ADDR` | `127.0.0.1:3000` |
| `--import-dir` | `TILEME_IMPORT_DIR` | `/tmp/tileme-imports` |
| `--osm2pgsql-bin` | `TILEME_OSM2PGSQL_BIN` | `osm2pgsql` |
| `--osm2pgsql-flex-path` | `TILEME_OSM2PGSQL_FLEX` | `osm2pgsql/flex.lua` |
| `--osm2pgsql-cache-mb` | `TILEME_OSM2PGSQL_CACHE_MB` | `1024` |
| `--log-json` | `TILEME_LOG_JSON` | `false` |
| `--debug-vite-origin` | `TILEME_DEBUG_VITE_ORIGIN` | `http://127.0.0.1:4000` in debug builds |

Import workers are woken through Postgres `LISTEN/NOTIFY` on the `tileme_import_jobs` channel. The process also performs a fixed slow sweep as a fallback for startup and missed notifications.
