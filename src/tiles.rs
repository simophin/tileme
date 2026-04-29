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
use crate::error::AppError;

pub const MAX_ZOOM: u8 = 18;

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

async fn tilejson() -> Json<TileJson> {
    Json(TileJson {
        tilejson: "3.0.0",
        name: "tileme",
        version: "0.1.0",
        scheme: "xyz",
        tiles: vec!["/tiles/{z}/{x}/{y}.pbf".into()],
        minzoom: 0,
        maxzoom: MAX_ZOOM,
        vector_layers: vec![
            layer("water", 0, MAX_ZOOM),
            layer("landuse", 8, MAX_ZOOM),
            layer("roads", 5, MAX_ZOOM),
            layer("buildings", 14, MAX_ZOOM),
            layer("addresses", 16, MAX_ZOOM),
            layer("places", 2, MAX_ZOOM),
            layer("pois", 15, MAX_ZOOM),
            layer("boundaries", 0, MAX_ZOOM),
        ],
    })
}

fn layer(id: &'static str, minzoom: u8, maxzoom: u8) -> VectorLayer {
    VectorLayer {
        id,
        fields: serde_json::json!({
            "class": "String",
            "source": "String",
            "name": "String",
            "house_number": "String",
            "street": "String",
            "unit": "String",
            "ref": "String",
            "height": "Number",
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
    let mvt = vector_tile_bytes(&state, z, x, y).await?;
    state.metrics.tile_requests.with_label_values(&["ok"]).inc();
    Ok(tile_response(mvt))
}

async fn vector_tile_bytes(
    state: &Arc<AppState>,
    z: u8,
    x: u32,
    y: u32,
) -> Result<Vec<u8>, AppError> {
    let started = Instant::now();
    let z_label = z.to_string();

    let timer = state
        .metrics
        .tile_generation_seconds
        .with_label_values(&[&z_label])
        .start_timer();
    let mvt = generate_tile(&state, z, x, y).await?;
    timer.observe_duration();

    state
        .metrics
        .tile_generation_seconds
        .with_label_values(&[&z_label])
        .observe(started.elapsed().as_secs_f64());
    Ok(mvt)
}

fn validate_tile(z: u8, x: u32, y: u32) -> Result<(), AppError> {
    if z > MAX_ZOOM {
        return Err(AppError::BadRequest(format!("max zoom is {MAX_ZOOM}")));
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
        SELECT class, name, house_number, height, ST_AsMVTGeom(b.geom, bounds.geom, 4096, 64, true) AS geom
        FROM osm_buildings b, bounds
        WHERE $1 >= 14 AND b.geom && bounds.geom
    ) building_rows
),
addresses AS (
    SELECT ST_AsMVT(address_rows, 'addresses', 4096, 'geom') AS mvt
    FROM (
        SELECT name, house_number, street, unit, ST_AsMVTGeom(a.geom, bounds.geom, 4096, 64, true) AS geom
        FROM osm_addresses a, bounds
        WHERE $1 >= 16
          AND a.geom && bounds.geom
    ) address_rows
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
pois AS (
    SELECT ST_AsMVT(poi_rows, 'pois', 4096, 'geom') AS mvt
    FROM (
        SELECT source, class, name, ST_AsMVTGeom(p.geom, bounds.geom, 4096, 64, true) AS geom
        FROM osm_pois p, bounds
        WHERE $1 >= 15
          AND p.geom && bounds.geom
    ) poi_rows
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
    COALESCE((SELECT mvt FROM addresses), '\x'::bytea) ||
    COALESCE((SELECT mvt FROM places), '\x'::bytea) ||
    COALESCE((SELECT mvt FROM pois), '\x'::bytea) ||
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

    (StatusCode::OK, headers, mvt).into_response()
}
