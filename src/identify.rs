use std::sync::Arc;

use axum::extract::{Query, State};
use axum::routing::get;
use axum::Json;
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::app::AppState;
use crate::error::AppError;

const DEFAULT_RADIUS_METERS: f64 = 35.0;
const MAX_RADIUS_METERS: f64 = 250.0;
const MAX_RESULTS: i64 = 20;

const DEFAULT_ADDRESS_LOOKUP_RADIUS_METERS: f64 = 250.0;
const MAX_ADDRESS_LOOKUP_RADIUS_METERS: f64 = 1_000.0;

pub fn router() -> axum::Router<Arc<AppState>> {
    axum::Router::new()
        .route("/identify", get(identify))
        .route("/address_lookup", get(address_lookup))
}

#[derive(Debug, Deserialize)]
struct CoordinateQuery {
    lat: f64,
    lon: f64,
    radius_meters: Option<f64>,
}

#[derive(Debug, Serialize)]
struct IdentifyResponse {
    lat: f64,
    lon: f64,
    radius_meters: f64,
    features: Vec<IdentifiedFeature>,
}

#[derive(Debug, Serialize)]
struct IdentifiedFeature {
    layer: String,
    osm_id: i64,
    source: Option<String>,
    class: Option<String>,
    name: String,
    distance_meters: f64,
    lat: Option<f64>,
    lon: Option<f64>,
}

#[derive(Debug, Serialize)]
struct AddressLookupResponse {
    lat: f64,
    lon: f64,
    radius_meters: f64,
    address: Option<ResolvedAddress>,
}

#[derive(Debug, Serialize)]
struct ResolvedAddress {
    osm_id: i64,
    formatted_address: String,
    unit: Option<String>,
    house_number: String,
    street: Option<String>,
    suburb: Option<String>,
    city: Option<String>,
    state: Option<String>,
    postcode: Option<String>,
    distance_meters: f64,
    lat: f64,
    lon: f64,
}

async fn identify(
    State(state): State<Arc<AppState>>,
    Query(query): Query<CoordinateQuery>,
) -> Result<Json<IdentifyResponse>, AppError> {
    validate_coordinate(query.lat, query.lon)?;

    let radius_meters = query
        .radius_meters
        .unwrap_or(DEFAULT_RADIUS_METERS)
        .clamp(1.0, MAX_RADIUS_METERS);
    let projected_radius = radius_meters / query.lat.to_radians().cos().abs().max(0.2);

    let rows = sqlx::query(
        r#"
WITH click AS (
    SELECT
        ST_Transform(ST_SetSRID(ST_MakePoint($1, $2), 4326), 3857) AS geom,
        ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography AS geog
),
matches AS (
    SELECT
        'building' AS layer,
        b.osm_id,
        'building' AS source,
        b.class,
        CASE
            WHEN b.name IS NOT NULL AND b.name <> '' THEN b.name
            WHEN b.class IS NOT NULL AND b.class <> 'yes' THEN initcap(replace(b.class, '_', ' '))
            ELSE 'Building'
        END AS name,
        ST_Distance(ST_Transform(ST_PointOnSurface(b.geom), 4326)::geography, click.geog) AS distance_meters,
        NULL::double precision AS lat,
        NULL::double precision AS lon,
        1 AS priority
    FROM osm_buildings b, click
    WHERE b.geom && ST_Expand(click.geom, $3)
      AND ST_DWithin(ST_Transform(ST_PointOnSurface(b.geom), 4326)::geography, click.geog, $4)

    UNION ALL

    SELECT
        'poi' AS layer,
        p.osm_id,
        p.source,
        p.class,
        p.name,
        ST_Distance(ST_Transform(p.geom, 4326)::geography, click.geog) AS distance_meters,
        ST_Y(ST_Transform(p.geom, 4326)) AS lat,
        ST_X(ST_Transform(p.geom, 4326)) AS lon,
        2 AS priority
    FROM osm_pois p, click
    WHERE p.geom && ST_Expand(click.geom, $3)
      AND ST_DWithin(ST_Transform(p.geom, 4326)::geography, click.geog, $4)

    UNION ALL

    SELECT
        'place' AS layer,
        p.osm_id,
        'place' AS source,
        p.class,
        p.name,
        ST_Distance(ST_Transform(p.geom, 4326)::geography, click.geog) AS distance_meters,
        ST_Y(ST_Transform(p.geom, 4326)) AS lat,
        ST_X(ST_Transform(p.geom, 4326)) AS lon,
        3 AS priority
    FROM osm_places p, click
    WHERE p.geom && ST_Expand(click.geom, $3)
      AND ST_DWithin(ST_Transform(p.geom, 4326)::geography, click.geog, $4)

    UNION ALL

    SELECT
        'road' AS layer,
        r.osm_id,
        'highway' AS source,
        r.class,
        COALESCE(r.name, r.ref) AS name,
        ST_Distance(ST_Transform(r.geom, 4326)::geography, click.geog) AS distance_meters,
        NULL::double precision AS lat,
        NULL::double precision AS lon,
        4 AS priority
    FROM osm_roads r, click
    WHERE COALESCE(r.name, r.ref) IS NOT NULL
      AND r.geom && ST_Expand(click.geom, $3)
      AND ST_DWithin(ST_Transform(r.geom, 4326)::geography, click.geog, $4)

    UNION ALL

    SELECT
        'water' AS layer,
        w.osm_id,
        'natural' AS source,
        w.class,
        w.name,
        0::double precision AS distance_meters,
        NULL::double precision AS lat,
        NULL::double precision AS lon,
        5 AS priority
    FROM osm_water w, click
    WHERE w.name IS NOT NULL
      AND w.geom && click.geom
      AND ST_Intersects(w.geom, click.geom)

    UNION ALL

    SELECT
        'landuse' AS layer,
        l.osm_id,
        'landuse' AS source,
        l.class,
        l.name,
        0::double precision AS distance_meters,
        NULL::double precision AS lat,
        NULL::double precision AS lon,
        6 AS priority
    FROM osm_landuse l, click
    WHERE l.name IS NOT NULL
      AND l.geom && click.geom
      AND ST_Intersects(l.geom, click.geom)
)
SELECT layer, osm_id, source, class, name, distance_meters, lat, lon
FROM matches
ORDER BY priority, distance_meters, name
LIMIT $5
"#,
    )
    .bind(query.lon)
    .bind(query.lat)
    .bind(projected_radius)
    .bind(radius_meters)
    .bind(MAX_RESULTS)
    .fetch_all(&state.pool)
    .await?;

    let features = rows
        .into_iter()
        .map(|row| {
            Ok(IdentifiedFeature {
                layer: row.try_get("layer")?,
                osm_id: row.try_get("osm_id")?,
                source: row.try_get("source")?,
                class: row.try_get("class")?,
                name: row.try_get("name")?,
                distance_meters: row.try_get("distance_meters")?,
                lat: row.try_get("lat")?,
                lon: row.try_get("lon")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()?;

    Ok(Json(IdentifyResponse {
        lat: query.lat,
        lon: query.lon,
        radius_meters,
        features,
    }))
}

async fn address_lookup(
    State(state): State<Arc<AppState>>,
    Query(query): Query<CoordinateQuery>,
) -> Result<Json<AddressLookupResponse>, AppError> {
    validate_coordinate(query.lat, query.lon)?;

    let radius_meters = query
        .radius_meters
        .unwrap_or(DEFAULT_ADDRESS_LOOKUP_RADIUS_METERS)
        .clamp(1.0, MAX_ADDRESS_LOOKUP_RADIUS_METERS);
    let projected_radius = radius_meters / query.lat.to_radians().cos().abs().max(0.2);

    let address_row = sqlx::query(
        r#"
WITH click AS (
    SELECT
        ST_Transform(ST_SetSRID(ST_MakePoint($1, $2), 4326), 3857) AS geom,
        ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography AS geog
)
SELECT
    a.osm_id,
    concat_ws(
        ', ',
        concat_ws(
            ' ',
            CASE
                WHEN a.unit IS NOT NULL AND a.unit <> '' THEN a.unit || '/' || a.house_number
                ELSE a.house_number
            END,
            a.street
        ),
        a.suburb,
        a.city,
        concat_ws(' ', a.state, a.postcode)
    ) AS formatted_address,
    a.unit,
    a.house_number,
    a.street,
    a.suburb,
    a.city,
    a.state,
    a.postcode,
    ST_Distance(ST_Transform(a.geom, 4326)::geography, click.geog) AS distance_meters,
    ST_Y(ST_Transform(a.geom, 4326)) AS lat,
    ST_X(ST_Transform(a.geom, 4326)) AS lon
FROM osm_addresses a, click
WHERE a.geom && ST_Expand(click.geom, $3)
  AND ST_DWithin(ST_Transform(a.geom, 4326)::geography, click.geog, $4)
ORDER BY distance_meters, a.house_number, a.street
LIMIT 1
"#,
    )
    .bind(query.lon)
    .bind(query.lat)
    .bind(projected_radius)
    .bind(radius_meters)
    .fetch_optional(&state.pool)
    .await?;

    let address = if let Some(row) = address_row {
        Some(ResolvedAddress {
            osm_id: row.try_get("osm_id")?,
            formatted_address: row.try_get("formatted_address")?,
            unit: row.try_get("unit")?,
            house_number: row.try_get("house_number")?,
            street: row.try_get("street")?,
            suburb: row.try_get("suburb")?,
            city: row.try_get("city")?,
            state: row.try_get("state")?,
            postcode: row.try_get("postcode")?,
            distance_meters: row.try_get("distance_meters")?,
            lat: row.try_get("lat")?,
            lon: row.try_get("lon")?,
        })
    } else {
        None
    };

    Ok(Json(AddressLookupResponse {
        lat: query.lat,
        lon: query.lon,
        radius_meters,
        address,
    }))
}

fn validate_coordinate(lat: f64, lon: f64) -> Result<(), AppError> {
    if !lat.is_finite() || !lon.is_finite() {
        return Err(AppError::BadRequest(
            "lat and lon must be finite numbers".into(),
        ));
    }
    if !(-90.0..=90.0).contains(&lat) {
        return Err(AppError::BadRequest(
            "lat must be between -90 and 90".into(),
        ));
    }
    if !(-180.0..=180.0).contains(&lon) {
        return Err(AppError::BadRequest(
            "lon must be between -180 and 180".into(),
        ));
    }
    Ok(())
}
