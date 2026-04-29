use std::sync::Arc;
use std::time::Instant;

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderValue, Response, StatusCode};
use axum::response::IntoResponse;
use image::codecs::png::PngEncoder;
use image::{ColorType, ImageEncoder};
use maplibre_native::SingleThreadedRenderPool;
use sha2::{Digest, Sha256};
use sqlx::Row;

use crate::app::AppState;
use crate::db;
use crate::error::AppError;
use crate::tiles;

const RENDERER_VERSION: &[u8] = b"tileme-maplibre-native-v1";
const RASTER_STYLE_FILENAME: &str = "tileme-raster-style.json";

pub fn router() -> axum::Router<Arc<AppState>> {
    axum::Router::new().route("/raster/{z}/{x}/{y}", axum::routing::get(raster_tile))
}

async fn raster_tile(
    State(state): State<Arc<AppState>>,
    Path((z, x, y)): Path<(u8, u32, String)>,
) -> Result<Response<Body>, AppError> {
    let y = parse_png_y(&y)?;
    tiles::validate_tile(z, x, y)?;

    let started = Instant::now();
    let version = db::current_tile_version(&state.pool).await?;
    let style_version = state.config.raster_style_version;
    let z_label = z.to_string();

    let mvt = tiles::vector_tile_bytes(&state, z, x, y).await?;
    let mvt_hash = sha256(&mvt);
    let render_hash = render_hash(style_version, z, x, y, &mvt_hash);

    if let Some(png) = read_cached_tile(&state, version, z, x, y, style_version).await? {
        state
            .metrics
            .raster_cache_hits
            .with_label_values(&[&z_label])
            .inc();
        state
            .metrics
            .raster_requests
            .with_label_values(&["ok"])
            .inc();
        return Ok(png_response(png));
    }

    if let Some(png) = read_cached_blob(&state, &render_hash).await? {
        write_ref(
            &state,
            version,
            z,
            x,
            y,
            style_version,
            &mvt_hash,
            &render_hash,
        )
        .await?;
        state
            .metrics
            .raster_cache_hits
            .with_label_values(&[&z_label])
            .inc();
        state
            .metrics
            .raster_requests
            .with_label_values(&["ok"])
            .inc();
        return Ok(png_response(png));
    }

    state
        .metrics
        .raster_cache_misses
        .with_label_values(&[&z_label])
        .inc();

    let timer = state
        .metrics
        .raster_generation_seconds
        .with_label_values(&[&z_label])
        .start_timer();
    let png = render_with_maplibre(&state, z, x, y).await?;
    timer.observe_duration();

    write_blob_and_ref(
        &state,
        version,
        z,
        x,
        y,
        style_version,
        &mvt_hash,
        &render_hash,
        &png,
    )
    .await?;
    sweep_lru(&state).await?;

    state
        .metrics
        .raster_generation_seconds
        .with_label_values(&[&z_label])
        .observe(started.elapsed().as_secs_f64());
    state
        .metrics
        .raster_requests
        .with_label_values(&["ok"])
        .inc();
    Ok(png_response(png))
}

fn parse_png_y(value: &str) -> Result<u32, AppError> {
    let Some(raw) = value.strip_suffix(".png") else {
        return Err(AppError::BadRequest(
            "raster tile path must end with .png".into(),
        ));
    };
    raw.parse()
        .map_err(|_| AppError::BadRequest("invalid tile y coordinate".into()))
}

fn sha256(bytes: &[u8]) -> Vec<u8> {
    Sha256::digest(bytes).to_vec()
}

fn render_hash(style_version: i32, z: u8, x: u32, y: u32, mvt_hash: &[u8]) -> Vec<u8> {
    let mut hasher = Sha256::new();
    hasher.update(RENDERER_VERSION);
    hasher.update(style_version.to_be_bytes());
    hasher.update([z]);
    hasher.update(x.to_be_bytes());
    hasher.update(y.to_be_bytes());
    hasher.update(mvt_hash);
    hasher.finalize().to_vec()
}

async fn read_cached_tile(
    state: &Arc<AppState>,
    version: i64,
    z: u8,
    x: u32,
    y: u32,
    style_version: i32,
) -> Result<Option<Vec<u8>>, AppError> {
    let row = sqlx::query(
        r#"
        SELECT b.render_hash, b.png
        FROM raster_tile_refs r
        JOIN raster_tile_blobs b ON b.render_hash = r.render_hash
        WHERE r.version = $1
          AND r.z = $2
          AND r.x = $3
          AND r.y = $4
          AND r.style_version = $5
        "#,
    )
    .bind(version)
    .bind(i32::from(z))
    .bind(x as i32)
    .bind(y as i32)
    .bind(style_version)
    .fetch_optional(&state.pool)
    .await?;

    if let Some(row) = row {
        let render_hash: Vec<u8> = row.try_get("render_hash")?;
        touch_blob(state, &render_hash).await?;
        return Ok(Some(row.try_get("png")?));
    }

    Ok(None)
}

async fn read_cached_blob(
    state: &Arc<AppState>,
    render_hash: &[u8],
) -> Result<Option<Vec<u8>>, AppError> {
    let row = sqlx::query("SELECT png FROM raster_tile_blobs WHERE render_hash = $1")
        .bind(render_hash)
        .fetch_optional(&state.pool)
        .await?;

    if let Some(row) = row {
        touch_blob(state, render_hash).await?;
        return Ok(Some(row.try_get("png")?));
    }

    Ok(None)
}

async fn touch_blob(state: &Arc<AppState>, render_hash: &[u8]) -> Result<(), AppError> {
    sqlx::query(
        r#"
        UPDATE raster_tile_blobs
        SET access_count = access_count + 1,
            last_accessed_at = now()
        WHERE render_hash = $1
          AND last_accessed_at < now() - ($2 * interval '1 second')
        "#,
    )
    .bind(render_hash)
    .bind(state.config.raster_cache_touch_interval_seconds)
    .execute(&state.pool)
    .await?;
    Ok(())
}

async fn write_ref(
    state: &Arc<AppState>,
    version: i64,
    z: u8,
    x: u32,
    y: u32,
    style_version: i32,
    mvt_hash: &[u8],
    render_hash: &[u8],
) -> Result<(), AppError> {
    sqlx::query(
        r#"
        INSERT INTO raster_tile_refs (version, z, x, y, style_version, mvt_hash, render_hash)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (version, z, x, y, style_version)
        DO UPDATE SET
            mvt_hash = EXCLUDED.mvt_hash,
            render_hash = EXCLUDED.render_hash,
            created_at = now()
        "#,
    )
    .bind(version)
    .bind(i32::from(z))
    .bind(x as i32)
    .bind(y as i32)
    .bind(style_version)
    .bind(mvt_hash)
    .bind(render_hash)
    .execute(&state.pool)
    .await?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn write_blob_and_ref(
    state: &Arc<AppState>,
    version: i64,
    z: u8,
    x: u32,
    y: u32,
    style_version: i32,
    mvt_hash: &[u8],
    render_hash: &[u8],
    png: &[u8],
) -> Result<(), AppError> {
    let mut tx = state.pool.begin().await?;
    sqlx::query(
        r#"
        INSERT INTO raster_tile_blobs (render_hash, png, byte_size)
        VALUES ($1, $2, $3)
        ON CONFLICT (render_hash) DO UPDATE SET
            access_count = raster_tile_blobs.access_count + 1,
            last_accessed_at = now()
        "#,
    )
    .bind(render_hash)
    .bind(png)
    .bind(png.len() as i64)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO raster_tile_refs (version, z, x, y, style_version, mvt_hash, render_hash)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (version, z, x, y, style_version)
        DO UPDATE SET
            mvt_hash = EXCLUDED.mvt_hash,
            render_hash = EXCLUDED.render_hash,
            created_at = now()
        "#,
    )
    .bind(version)
    .bind(i32::from(z))
    .bind(x as i32)
    .bind(y as i32)
    .bind(style_version)
    .bind(mvt_hash)
    .bind(render_hash)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(())
}

async fn sweep_lru(state: &Arc<AppState>) -> Result<(), AppError> {
    if state.config.raster_cache_max_bytes <= 0 {
        return Ok(());
    }

    sqlx::query(
        r#"
        WITH total AS (
            SELECT COALESCE(sum(byte_size), 0) AS bytes FROM raster_tile_blobs
        ),
        victims AS (
            SELECT render_hash
            FROM raster_tile_blobs, total
            WHERE total.bytes > $1
            ORDER BY last_accessed_at ASC
            LIMIT 64
        )
        DELETE FROM raster_tile_blobs
        WHERE render_hash IN (SELECT render_hash FROM victims)
        "#,
    )
    .bind(state.config.raster_cache_max_bytes)
    .execute(&state.pool)
    .await?;
    Ok(())
}

async fn render_with_maplibre(
    state: &Arc<AppState>,
    z: u8,
    x: u32,
    y: u32,
) -> Result<Vec<u8>, AppError> {
    let style_path = ensure_maplibre_style(state).await?;
    let image = SingleThreadedRenderPool::global_pool()
        .render_tile(style_path, z, x, y)
        .await
        .map_err(|err| AppError::BadRequest(format!("MapLibre renderer failed: {err}")))?;
    encode_png(image.as_image())
}

async fn ensure_maplibre_style(state: &Arc<AppState>) -> Result<std::path::PathBuf, AppError> {
    let base_url = raster_base_url(state);
    let style_path = state.config.import_dir.join(RASTER_STYLE_FILENAME);
    let style = maplibre_style_json(&base_url)?;

    tokio::fs::create_dir_all(&state.config.import_dir).await?;
    tokio::fs::write(&style_path, style).await?;
    Ok(style_path)
}

fn raster_base_url(state: &Arc<AppState>) -> String {
    state
        .config
        .public_base_url
        .clone()
        .unwrap_or_else(|| {
            let listen_addr = state.config.listen_addr.as_str();
            if let Some(port) = listen_addr.strip_prefix("0.0.0.0:") {
                format!("http://127.0.0.1:{port}")
            } else {
                format!("http://{listen_addr}")
            }
        })
        .trim_end_matches('/')
        .to_owned()
}

fn maplibre_style_json(base_url: &str) -> Result<String, AppError> {
    serde_json::to_string(&serde_json::json!({
        "version": 8,
        "name": "tileme-raster",
        "glyphs": "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
        "sources": {
            "tileme": {
                "type": "vector",
                "tiles": [format!("{base_url}/tiles/{{z}}/{{x}}/{{y}}.pbf")],
                "minzoom": 0,
                "maxzoom": 18
            }
        },
        "layers": [
            {
                "id": "background",
                "type": "background",
                "paint": { "background-color": "#edf0e7" }
            },
            {
                "id": "water",
                "type": "fill",
                "source": "tileme",
                "source-layer": "water",
                "paint": { "fill-color": "#8fb9d4", "fill-opacity": 0.92 }
            },
            {
                "id": "landuse",
                "type": "fill",
                "source": "tileme",
                "source-layer": "landuse",
                "paint": { "fill-color": "#bfd4ad", "fill-opacity": 0.5 }
            },
            {
                "id": "boundaries",
                "type": "line",
                "source": "tileme",
                "source-layer": "boundaries",
                "paint": {
                    "line-color": "#8d7c6d",
                    "line-width": 1.0,
                    "line-opacity": 0.65
                }
            },
            {
                "id": "road-casing",
                "type": "line",
                "source": "tileme",
                "source-layer": "roads",
                "paint": {
                    "line-color": "#b8afa4",
                    "line-width": ["interpolate", ["linear"], ["zoom"], 0, 1.1, 10, 1.8, 12, 2.6, 14, 3.8, 15, 5.0, 16, 6.0],
                    "line-opacity": 0.85
                }
            },
            {
                "id": "roads-motorway-trunk",
                "type": "line",
                "source": "tileme",
                "source-layer": "roads",
                "filter": ["in", ["get", "class"], ["literal", ["motorway", "trunk"]]],
                "paint": {
                    "line-color": "#f1b35f",
                    "line-width": ["interpolate", ["linear"], ["zoom"], 0, 0.6, 10, 1.0, 12, 1.5, 14, 2.3, 15, 3.2, 16, 4.1],
                    "line-opacity": 0.98
                }
            },
            {
                "id": "roads",
                "type": "line",
                "source": "tileme",
                "source-layer": "roads",
                "filter": ["!", ["in", ["get", "class"], ["literal", ["motorway", "trunk"]]]],
                "paint": {
                    "line-color": "#fff8ea",
                    "line-width": ["interpolate", ["linear"], ["zoom"], 0, 0.6, 10, 1.0, 12, 1.5, 14, 2.3, 15, 3.2, 16, 4.1],
                    "line-opacity": 0.95
                }
            },
            {
                "id": "buildings",
                "type": "fill",
                "source": "tileme",
                "source-layer": "buildings",
                "paint": { "fill-color": "#c6a889", "fill-opacity": 0.76 }
            },
            {
                "id": "water-labels",
                "type": "symbol",
                "source": "tileme",
                "source-layer": "water",
                "minzoom": 8,
                "filter": ["has", "name"],
                "layout": {
                    "text-field": ["get", "name"],
                    "text-font": ["Noto Sans Regular"],
                    "text-size": ["interpolate", ["linear"], ["zoom"], 8, 9, 12, 11, 16, 12],
                    "text-allow-overlap": false
                },
                "paint": {
                    "text-color": "#31677f",
                    "text-halo-color": "#d9edf5",
                    "text-halo-width": 1.1
                }
            },
            {
                "id": "landuse-labels",
                "type": "symbol",
                "source": "tileme",
                "source-layer": "landuse",
                "minzoom": 12,
                "filter": [
                    "all",
                    ["has", "name"],
                    ["in", ["get", "class"], ["literal", ["park", "wood", "forest", "nature_reserve", "recreation_ground", "grass"]]]
                ],
                "layout": {
                    "text-field": ["get", "name"],
                    "text-font": ["Noto Sans Regular"],
                    "text-size": ["interpolate", ["linear"], ["zoom"], 12, 9, 15, 11],
                    "text-allow-overlap": false
                },
                "paint": {
                    "text-color": "#4f7447",
                    "text-halo-color": "#eff6e8",
                    "text-halo-width": 1.1
                }
            },
            {
                "id": "road-labels",
                "type": "symbol",
                "source": "tileme",
                "source-layer": "roads",
                "minzoom": 13,
                "layout": {
                    "symbol-placement": "line",
                    "text-field": ["coalesce", ["get", "name"], ["get", "ref"]],
                    "text-font": ["Noto Sans Regular"],
                    "text-size": ["interpolate", ["linear"], ["zoom"], 13, 9, 15, 10],
                    "symbol-spacing": ["interpolate", ["linear"], ["zoom"], 13, 360, 15, 260]
                },
                "paint": {
                    "text-color": "#5c554c",
                    "text-halo-color": "#fff8ea",
                    "text-halo-width": 1.2
                }
            },
            {
                "id": "poi-labels",
                "type": "symbol",
                "source": "tileme",
                "source-layer": "pois",
                "minzoom": 15,
                "layout": {
                    "text-field": ["get", "name"],
                    "text-font": ["Noto Sans Regular"],
                    "text-size": ["interpolate", ["linear"], ["zoom"], 15, 9, 16, 10],
                    "text-anchor": "top",
                    "text-offset": [0, 0.6],
                    "text-allow-overlap": false,
                    "symbol-sort-key": [
                        "match",
                        ["get", "source"],
                        "tourism", 1,
                        "amenity", 2,
                        "leisure", 3,
                        "shop", 4,
                        5
                    ]
                },
                "paint": {
                    "text-color": "#4f463b",
                    "text-halo-color": "#fffdf5",
                    "text-halo-width": 1.1
                }
            },
            {
                "id": "places",
                "type": "symbol",
                "source": "tileme",
                "source-layer": "places",
                "layout": {
                    "text-field": ["get", "name"],
                    "text-font": ["Noto Sans Regular"],
                    "text-size": ["interpolate", ["linear"], ["zoom"], 0, 10, 11, 11],
                    "text-allow-overlap": false
                },
                "paint": {
                    "text-color": "#26302d",
                    "text-halo-color": "#ffffff",
                    "text-halo-width": 1.2
                }
            }
        ]
    }))
    .map_err(|err| AppError::BadRequest(format!("failed to build MapLibre style: {err}")))
}

fn encode_png(image: &image::RgbaImage) -> Result<Vec<u8>, AppError> {
    let mut png = Vec::new();
    PngEncoder::new(&mut png)
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            ColorType::Rgba8.into(),
        )
        .map_err(|err| AppError::BadRequest(format!("failed to encode raster PNG: {err}")))?;
    Ok(png)
}

fn png_response(png: Vec<u8>) -> Response<Body> {
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("image/png"));
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=3600"),
    );

    (StatusCode::OK, headers, png).into_response()
}
