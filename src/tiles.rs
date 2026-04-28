use std::sync::Arc;
use std::time::Instant;

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderValue, Response, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Json;
use serde::Serialize;
use sqlx::Row;

use crate::app::AppState;
use crate::db;
use crate::error::AppError;

pub fn router() -> axum::Router<Arc<AppState>> {
    axum::Router::new()
        .route("/tiles.json", get(tilejson))
        .route("/tiles/{z}/{x}/{y}", get(tile))
}

#[derive(Serialize)]
struct TileJson {
    tilejson: &'static str,
    name: &'static str,
    version: &'static str,
    scheme: &'static str,
    tiles: Vec<String>,
    minzoom: u8,
    maxzoom: u8,
    vector_layers: Vec<VectorLayer>,
}

#[derive(Serialize)]
struct VectorLayer {
    id: &'static str,
    fields: serde_json::Value,
    minzoom: u8,
    maxzoom: u8,
}

async fn tilejson(State(state): State<Arc<AppState>>) -> Json<TileJson> {
    let tile_url = match &state.config.public_base_url {
        Some(base) => format!("{}/tiles/{{z}}/{{x}}/{{y}}.pbf", base.trim_end_matches('/')),
        None => "/tiles/{z}/{x}/{y}.pbf".into(),
    };

    Json(TileJson {
        tilejson: "3.0.0",
        name: "tileme",
        version: "0.1.0",
        scheme: "xyz",
        tiles: vec![tile_url],
        minzoom: 0,
        maxzoom: 14,
        vector_layers: vec![
            layer("water", 0, 14),
            layer("landuse", 8, 14),
            layer("roads", 5, 14),
            layer("buildings", 14, 14),
            layer("places", 2, 14),
            layer("boundaries", 0, 14),
        ],
    })
}

fn layer(id: &'static str, minzoom: u8, maxzoom: u8) -> VectorLayer {
    VectorLayer {
        id,
        fields: serde_json::json!({
            "class": "String",
            "name": "String",
            "ref": "String",
            "admin_level": "Number"
        }),
        minzoom,
        maxzoom,
    }
}

async fn tile(
    State(state): State<Arc<AppState>>,
    Path((z, x, y)): Path<(u8, u32, String)>,
) -> Result<Response<Body>, AppError> {
    let y = parse_y(&y)?;
    validate_tile(z, x, y)?;
    let started = Instant::now();
    let version = db::current_tile_version(&state.pool).await?;
    let cacheable = z <= state.config.cache_max_zoom;
    let z_label = z.to_string();

    if cacheable {
        if let Some(mvt) = read_cache(&state, version, z, x, y).await? {
            state
                .metrics
                .tile_cache_hits
                .with_label_values(&[&z_label])
                .inc();
            state.metrics.tile_requests.with_label_values(&["ok"]).inc();
            return Ok(tile_response(mvt));
        }
        state
            .metrics
            .tile_cache_misses
            .with_label_values(&[&z_label])
            .inc();
    }

    let timer = state
        .metrics
        .tile_generation_seconds
        .with_label_values(&[&z_label])
        .start_timer();
    let mvt = generate_tile(&state, z, x, y).await?;
    timer.observe_duration();

    if cacheable && !mvt.is_empty() {
        write_cache(&state, version, z, x, y, &mvt).await?;
    }

    state
        .metrics
        .tile_generation_seconds
        .with_label_values(&[&z_label])
        .observe(started.elapsed().as_secs_f64());
    state.metrics.tile_requests.with_label_values(&["ok"]).inc();
    Ok(tile_response(mvt))
}

fn validate_tile(z: u8, x: u32, y: u32) -> Result<(), AppError> {
    if z > 14 {
        return Err(AppError::BadRequest("max zoom is 14".into()));
    }
    let max = 1u32
        .checked_shl(z.into())
        .ok_or_else(|| AppError::BadRequest("invalid zoom".into()))?;
    if x >= max || y >= max {
        return Err(AppError::BadRequest("tile x/y outside zoom bounds".into()));
    }
    Ok(())
}

fn parse_y(value: &str) -> Result<u32, AppError> {
    let Some(raw) = value.strip_suffix(".pbf") else {
        return Err(AppError::BadRequest("tile path must end with .pbf".into()));
    };
    raw.parse()
        .map_err(|_| AppError::BadRequest("invalid tile y coordinate".into()))
}

async fn read_cache(
    state: &Arc<AppState>,
    version: i64,
    z: u8,
    x: u32,
    y: u32,
) -> Result<Option<Vec<u8>>, AppError> {
    let row = sqlx::query(
        "SELECT mvt FROM tile_cache WHERE version = $1 AND z = $2 AND x = $3 AND y = $4",
    )
    .bind(version)
    .bind(i32::from(z))
    .bind(x as i32)
    .bind(y as i32)
    .fetch_optional(&state.pool)
    .await?;
    Ok(row.map(|row| row.try_get("mvt")).transpose()?)
}

async fn write_cache(
    state: &Arc<AppState>,
    version: i64,
    z: u8,
    x: u32,
    y: u32,
    mvt: &[u8],
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO tile_cache (version, z, x, y, mvt)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (version, z, x, y) DO NOTHING",
    )
    .bind(version)
    .bind(i32::from(z))
    .bind(x as i32)
    .bind(y as i32)
    .bind(mvt)
    .execute(&state.pool)
    .await?;
    Ok(())
}

async fn generate_tile(state: &Arc<AppState>, z: u8, x: u32, y: u32) -> Result<Vec<u8>, AppError> {
    let water_table = if z <= 5 {
        "gen_water_z0_5"
    } else if z <= 8 {
        "gen_water_z6_8"
    } else {
        "osm_water"
    };

    let sql = format!(
        r#"
WITH bounds AS (
    SELECT ST_TileEnvelope($1, $2, $3) AS geom
),
water AS (
    SELECT ST_AsMVT(water_rows, 'water', 4096, 'geom') AS mvt
    FROM (
        SELECT class, name, ST_AsMVTGeom(w.geom, bounds.geom, 4096, 64, true) AS geom
        FROM {water_table} w, bounds
        WHERE w.geom && bounds.geom
    ) water_rows
),
landuse AS (
    SELECT ST_AsMVT(landuse_rows, 'landuse', 4096, 'geom') AS mvt
    FROM (
        SELECT class, name, ST_AsMVTGeom(l.geom, bounds.geom, 4096, 64, true) AS geom
        FROM osm_landuse l, bounds
        WHERE $1 >= 8
          AND l.geom && bounds.geom
          AND (
              $1 >= 12
              OR ($1 >= 10 AND ST_Area(l.geom) > 50000)
              OR ($1 >= 8 AND ST_Area(l.geom) > 250000)
          )
    ) landuse_rows
),
roads AS (
    SELECT ST_AsMVT(roads_rows, 'roads', 4096, 'geom') AS mvt
    FROM (
        SELECT class, name, ref, layer, tunnel, bridge, ST_AsMVTGeom(r.geom, bounds.geom, 4096, 64, true) AS geom
        FROM osm_roads r, bounds
        WHERE $1 >= 5
          AND r.geom && bounds.geom
          AND (
              $1 >= 14
              OR ($1 >= 13 AND r.class IN ('motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential'))
              OR ($1 >= 12 AND r.class IN ('motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified'))
              OR ($1 >= 10 AND r.class IN ('motorway', 'trunk', 'primary', 'secondary', 'tertiary'))
              OR ($1 >= 8 AND r.class IN ('motorway', 'trunk', 'primary'))
              OR ($1 >= 6 AND r.class IN ('motorway', 'trunk'))
              OR r.class = 'motorway'
          )
          AND (
              $1 >= 12
              OR ($1 >= 10 AND ST_Length(r.geom) > 250)
              OR ($1 >= 8 AND ST_Length(r.geom) > 500)
              OR ST_Length(r.geom) > 1000
          )
    ) roads_rows
),
buildings AS (
    SELECT ST_AsMVT(building_rows, 'buildings', 4096, 'geom') AS mvt
    FROM (
        SELECT class, height, ST_AsMVTGeom(b.geom, bounds.geom, 4096, 64, true) AS geom
        FROM osm_buildings b, bounds
        WHERE $1 >= 14 AND b.geom && bounds.geom
    ) building_rows
),
places AS (
    SELECT ST_AsMVT(place_rows, 'places', 4096, 'geom') AS mvt
    FROM (
        SELECT class, name, population, ST_AsMVTGeom(p.geom, bounds.geom, 4096, 64, true) AS geom
        FROM osm_places p, bounds
        WHERE $1 >= 2
          AND p.geom && bounds.geom
          AND (
              $1 >= 12
              OR ($1 >= 10 AND p.class IN ('city', 'town', 'village', 'suburb'))
              OR ($1 >= 7 AND p.class IN ('city', 'town', 'village'))
              OR ($1 >= 5 AND p.class IN ('city', 'town'))
              OR p.class = 'city'
          )
    ) place_rows
),
boundaries AS (
    SELECT ST_AsMVT(boundary_rows, 'boundaries', 4096, 'geom') AS mvt
    FROM (
        SELECT admin_level, name, ST_AsMVTGeom(b.geom, bounds.geom, 4096, 64, true) AS geom
        FROM osm_boundaries b, bounds
        WHERE b.geom && bounds.geom
          AND (
              $1 >= 10
              OR ($1 >= 7 AND b.admin_level <= 6)
              OR b.admin_level <= 4
          )
    ) boundary_rows
)
SELECT
    COALESCE((SELECT mvt FROM water), '\x'::bytea) ||
    COALESCE((SELECT mvt FROM landuse), '\x'::bytea) ||
    COALESCE((SELECT mvt FROM roads), '\x'::bytea) ||
    COALESCE((SELECT mvt FROM buildings), '\x'::bytea) ||
    COALESCE((SELECT mvt FROM places), '\x'::bytea) ||
    COALESCE((SELECT mvt FROM boundaries), '\x'::bytea) AS mvt
"#
    );

    let row = sqlx::query(&sql)
        .bind(i32::from(z))
        .bind(x as i32)
        .bind(y as i32)
        .fetch_one(&state.pool)
        .await?;
    Ok(row.try_get("mvt")?)
}

fn tile_response(mvt: Vec<u8>) -> Response<Body> {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/vnd.mapbox-vector-tile"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=3600"),
    );

    (StatusCode::OK, headers, mvt).into_response()
}
