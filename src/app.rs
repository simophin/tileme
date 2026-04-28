use std::sync::Arc;

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use prometheus::{Encoder, TextEncoder};
use serde::Serialize;
use sqlx::PgPool;

use crate::config::Config;
use crate::error::AppError;
use crate::metrics::Metrics;

#[derive(Clone)]
pub struct AppState {
    pub config: Config,
    pub pool: PgPool,
    pub metrics: Metrics,
}

impl AppState {
    pub fn new(config: Config, pool: PgPool, metrics: Metrics) -> Self {
        Self {
            config,
            pool,
            metrics,
        }
    }
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .route("/metrics", get(metrics))
}

#[derive(Serialize)]
struct StatusBody<'a> {
    status: &'a str,
}

async fn healthz() -> Json<StatusBody<'static>> {
    Json(StatusBody { status: "ok" })
}

async fn readyz(State(state): State<Arc<AppState>>) -> Result<Json<StatusBody<'static>>, AppError> {
    sqlx::query("SELECT 1").execute(&state.pool).await?;
    Ok(Json(StatusBody { status: "ready" }))
}

async fn metrics(State(state): State<Arc<AppState>>) -> Result<String, AppError> {
    let encoder = TextEncoder::new();
    let families = state.metrics.registry.gather();
    let mut buffer = Vec::new();
    encoder.encode(&families, &mut buffer)?;
    Ok(String::from_utf8(buffer)?)
}
