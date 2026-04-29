# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS frontend-build
WORKDIR /work/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

FROM rust:1.95-bookworm AS backend-build
WORKDIR /work

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential pkg-config perl \
    && rm -rf /var/lib/apt/lists/*

COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY osm2pgsql ./osm2pgsql
COPY frontend ./frontend
COPY --from=frontend-build /work/frontend/dist ./frontend/dist

RUN cargo build --release

FROM debian:bookworm-slim AS runtime
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates osm2pgsql \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --create-home --home-dir /app tileme \
    && mkdir -p /tmp/tileme-imports /app/osm2pgsql \
    && chown -R tileme:tileme /app /tmp/tileme-imports

COPY --from=backend-build /work/target/release/tileme /usr/local/bin/tileme
COPY osm2pgsql/flex.lua /app/osm2pgsql/flex.lua

ENV TILEME_LISTEN_ADDR=0.0.0.0:3000 \
    TILEME_IMPORT_DIR=/tmp/tileme-imports \
    TILEME_OSM2PGSQL_BIN=/usr/bin/osm2pgsql \
    TILEME_OSM2PGSQL_FLEX=/app/osm2pgsql/flex.lua

USER tileme

EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/tileme"]
