mod app;
mod config;
mod db;
mod error;
mod identify;
mod imports;
mod metrics;
mod search;
mod static_assets;
mod tiles;
mod trace;

use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::Context;
use axum::Router;
use tokio::net::TcpListener;
use tower_http::compression::CompressionLayer;
use tower_http::cors::CorsLayer;
use tower_http::request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer};
use tower_http::trace::TraceLayer;
use tracing::info;

use crate::app::AppState;
use crate::config::Config;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();

    let config = Config::from_args();
    trace::init(&config)?;

    let pool = db::connect_and_migrate(&config.database_url).await?;
    let metrics = metrics::Metrics::new()?;
    let state = Arc::new(AppState::new(config.clone(), pool, metrics));

    imports::mark_interrupted_jobs_failed(&state.pool).await?;

    let worker_state = Arc::clone(&state);
    let worker_handle = tokio::spawn(async move {
        imports::worker_loop(worker_state).await;
    });

    let app = router(state);
    let addr: SocketAddr = config
        .listen_addr
        .parse()
        .context("invalid TILEME_LISTEN_ADDR")?;
    let listener = TcpListener::bind(addr).await?;
    info!(%addr, "tileme listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    worker_handle.abort();
    Ok(())
}

fn router(state: Arc<AppState>) -> Router {
    let app = Router::new()
        .merge(app::router())
        .merge(identify::router())
        .merge(imports::router())
        .merge(search::router())
        .merge(tiles::router());

    #[cfg(debug_assertions)]
    let app = app.merge(static_assets::router(&state.config.debug_vite_origin));

    #[cfg(not(debug_assertions))]
    let app = app.merge(static_assets::router());

    app.layer(PropagateRequestIdLayer::x_request_id())
        .layer(SetRequestIdLayer::x_request_id(MakeRequestUuid))
        .layer(TraceLayer::new_for_http())
        .layer(CompressionLayer::new())
        .layer(CorsLayer::permissive())
        .with_state(state)
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        use tokio::signal::unix::{signal, SignalKind};
        if let Ok(mut sigterm) = signal(SignalKind::terminate()) {
            let _ = sigterm.recv().await;
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}
