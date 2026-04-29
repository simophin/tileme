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

pub fn router() -> axum::Router<Arc<AppState>> {
    axum::Router::new().route("/identify", get(identify))
}

#[derive(Debug, Deserialize)]
struct IdentifyQuery {
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
    house_number: Option<String>,
    street: Option<String>,
    distance_meters: f64,
    lat: Option<f64>,
    lon: Option<f64>,
}

async fn identify(
    State(state): State<Arc<AppState>>,
    Query(query): Query<IdentifyQuery>,
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
        'address' AS layer,
        a.osm_id,
        'address' AS source,
        NULL::text AS class,
        COALESCE(a.name, a.house_number) AS name,
        a.house_number,
        a.street,
        ST_Distance(ST_Transform(a.geom, 4326)::geography, click.geog) AS distance_meters,
        ST_Y(ST_Transform(a.geom, 4326)) AS lat,
        ST_X(ST_Transform(a.geom, 4326)) AS lon,
        1 AS priority
    FROM osm_addresses a, click
    WHERE a.geom && ST_Expand(click.geom, $3)
      AND ST_DWithin(ST_Transform(a.geom, 4326)::geography, click.geog, $4)

    UNION ALL

    SELECT
        'building' AS layer,
        b.osm_id,
        'building' AS source,
        b.class,
        COALESCE(
            b.name,
            b.house_number,
            CASE
                WHEN b.class IS NOT NULL AND b.class <> 'yes' THEN initcap(replace(b.class, '_', ' '))
                ELSE 'Building'
            END
        ) AS name,
        b.house_number,
        NULL::text AS street,
        ST_Distance(ST_Transform(ST_PointOnSurface(b.geom), 4326)::geography, click.geog) AS distance_meters,
        NULL::double precision AS lat,
        NULL::double precision AS lon,
        2 AS priority
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
        NULL::text AS house_number,
        NULL::text AS street,
        ST_Distance(ST_Transform(p.geom, 4326)::geography, click.geog) AS distance_meters,
        ST_Y(ST_Transform(p.geom, 4326)) AS lat,
        ST_X(ST_Transform(p.geom, 4326)) AS lon,
        3 AS priority
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
        NULL::text AS house_number,
        NULL::text AS street,
        ST_Distance(ST_Transform(p.geom, 4326)::geography, click.geog) AS distance_meters,
        ST_Y(ST_Transform(p.geom, 4326)) AS lat,
        ST_X(ST_Transform(p.geom, 4326)) AS lon,
        4 AS priority
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
        NULL::text AS house_number,
        NULL::text AS street,
        ST_Distance(ST_Transform(r.geom, 4326)::geography, click.geog) AS distance_meters,
        NULL::double precision AS lat,
        NULL::double precision AS lon,
        5 AS priority
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
        NULL::text AS house_number,
        NULL::text AS street,
        0::double precision AS distance_meters,
        NULL::double precision AS lat,
        NULL::double precision AS lon,
        6 AS priority
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
        NULL::text AS house_number,
        NULL::text AS street,
        0::double precision AS distance_meters,
        NULL::double precision AS lat,
        NULL::double precision AS lon,
        7 AS priority
    FROM osm_landuse l, click
    WHERE l.name IS NOT NULL
      AND l.geom && click.geom
      AND ST_Intersects(l.geom, click.geom)
)
SELECT layer, osm_id, source, class, name, house_number, street, distance_meters, lat, lon
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
                house_number: row.try_get("house_number")?,
                street: row.try_get("street")?,
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
