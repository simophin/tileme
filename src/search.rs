use std::sync::Arc;

use axum::extract::{Query, State};
use axum::routing::get;
use axum::Json;
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::app::AppState;
use crate::error::AppError;

const DEFAULT_LIMIT: i64 = 12;
const MAX_LIMIT: i64 = 50;
const MIN_QUERY_CHARS: usize = 2;

pub fn router() -> axum::Router<Arc<AppState>> {
    axum::Router::new().route("/search", get(search))
}

#[derive(Debug, Deserialize)]
struct SearchQuery {
    q: String,
    lat: Option<f64>,
    lon: Option<f64>,
    limit: Option<i64>,
}

#[derive(Debug, Serialize)]
struct SearchResponse {
    query: String,
    results: Vec<SearchResult>,
}

#[derive(Debug, Serialize)]
struct SearchResult {
    layer: String,
    import_name: String,
    osm_id: i64,
    source: Option<String>,
    class: Option<String>,
    name: String,
    distance_meters: Option<f64>,
    lat: f64,
    lon: f64,
}

async fn search(
    State(state): State<Arc<AppState>>,
    Query(query): Query<SearchQuery>,
) -> Result<Json<SearchResponse>, AppError> {
    let search_text = normalize_search_query(&query.q)?;
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    validate_optional_coordinate(query.lat, query.lon)?;

    let pattern = format!("%{}%", escape_like(&search_text));
    let prefix_pattern = format!("{}%", escape_like(&search_text));
    let exact_pattern = escape_like(&search_text);

    let rows = sqlx::query(
        r#"
WITH view_center AS (
    SELECT
        CASE
            WHEN $4::double precision IS NULL OR $5::double precision IS NULL THEN NULL::geometry
            ELSE ST_Transform(ST_SetSRID(ST_MakePoint($5, $4), 4326), 3857)
        END AS geom,
        CASE
            WHEN $4::double precision IS NULL OR $5::double precision IS NULL THEN NULL::geography
            ELSE ST_SetSRID(ST_MakePoint($5, $4), 4326)::geography
        END AS geog
),
matches AS (
    SELECT
        'place' AS layer,
        p.import_name,
        p.osm_id,
        'place' AS source,
        p.class,
        p.name,
        p.geom,
        CASE
            WHEN p.name ILIKE $2 ESCAPE '\' THEN 0
            WHEN p.name ILIKE $3 ESCAPE '\' THEN 1
            ELSE 2
        END AS match_rank,
        CASE
            WHEN p.class = 'city' THEN 0
            WHEN p.class = 'town' THEN 1
            WHEN p.class = 'suburb' THEN 2
            WHEN p.class = 'village' THEN 3
            ELSE 4
        END AS type_rank
    FROM osm_places p
    WHERE p.name ILIKE $1 ESCAPE '\'

    UNION ALL

    SELECT
        'admin_area' AS layer,
        a.import_name,
        a.osm_id,
        'boundary' AS source,
        a.admin_level::text AS class,
        a.name,
        ST_PointOnSurface(a.geom) AS geom,
        CASE
            WHEN a.name ILIKE $2 ESCAPE '\' THEN 0
            WHEN a.name ILIKE $3 ESCAPE '\' THEN 1
            ELSE 2
        END AS match_rank,
        COALESCE(a.admin_level, 99) AS type_rank
    FROM osm_admin_areas a
    WHERE a.name ILIKE $1 ESCAPE '\'

    UNION ALL

    SELECT
        'poi' AS layer,
        p.import_name,
        p.osm_id,
        p.source,
        p.class,
        p.name,
        p.geom,
        CASE
            WHEN p.name ILIKE $2 ESCAPE '\' THEN 0
            WHEN p.name ILIKE $3 ESCAPE '\' THEN 1
            ELSE 2
        END AS match_rank,
        20 AS type_rank
    FROM osm_pois p
    WHERE p.name ILIKE $1 ESCAPE '\'

    UNION ALL

    SELECT
        'transit_route' AS layer,
        t.import_name,
        t.osm_id,
        'route' AS source,
        t.class,
        COALESCE(t.name, t.ref) AS name,
        ST_PointOnSurface(t.geom) AS geom,
        CASE
            WHEN t.name ILIKE $2 ESCAPE '\' OR t.ref ILIKE $2 ESCAPE '\' THEN 0
            WHEN t.name ILIKE $3 ESCAPE '\' OR t.ref ILIKE $3 ESCAPE '\' THEN 1
            ELSE 2
        END AS match_rank,
        30 AS type_rank
    FROM osm_transit_routes t
    WHERE t.name ILIKE $1 ESCAPE '\' OR t.ref ILIKE $1 ESCAPE '\'
),
ranked AS (
    SELECT
        matches.*,
        CASE
            WHEN view_center.geog IS NULL THEN NULL::double precision
            ELSE ST_Distance(ST_Transform(matches.geom, 4326)::geography, view_center.geog)
        END AS distance_meters
    FROM matches
    CROSS JOIN view_center
)
SELECT
    layer,
    import_name,
    osm_id,
    source,
    class,
    name,
    distance_meters,
    ST_Y(ST_Transform(geom, 4326)) AS lat,
    ST_X(ST_Transform(geom, 4326)) AS lon
FROM ranked
ORDER BY distance_meters NULLS LAST, match_rank, type_rank, name, import_name
LIMIT $6
"#,
    )
    .bind(&pattern)
    .bind(&exact_pattern)
    .bind(&prefix_pattern)
    .bind(query.lat)
    .bind(query.lon)
    .bind(limit)
    .fetch_all(&state.pool)
    .await?;

    let results = rows
        .into_iter()
        .map(|row| {
            Ok(SearchResult {
                layer: row.try_get("layer")?,
                import_name: row.try_get("import_name")?,
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

    Ok(Json(SearchResponse {
        query: search_text,
        results,
    }))
}

fn normalize_search_query(value: &str) -> Result<String, AppError> {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.chars().count() < MIN_QUERY_CHARS {
        return Err(AppError::BadRequest(format!(
            "search query must be at least {MIN_QUERY_CHARS} characters"
        )));
    }
    Ok(normalized)
}

fn validate_optional_coordinate(lat: Option<f64>, lon: Option<f64>) -> Result<(), AppError> {
    match (lat, lon) {
        (Some(lat), Some(lon)) => {
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
        (None, None) => Ok(()),
        _ => Err(AppError::BadRequest(
            "lat and lon must be provided together".into(),
        )),
    }
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}
