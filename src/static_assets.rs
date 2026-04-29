use std::sync::Arc;

#[cfg(not(debug_assertions))]
use axum::body::Body;
#[cfg(not(debug_assertions))]
use axum::http::{header, HeaderValue, Response, StatusCode, Uri};
#[cfg(not(debug_assertions))]
use axum::response::IntoResponse;
#[cfg(not(debug_assertions))]
use axum::routing::get;
use axum::Router;
#[cfg(debug_assertions)]
use axum_reverse_proxy::ReverseProxy;
#[cfg(not(debug_assertions))]
use rust_embed::RustEmbed;

use crate::app::AppState;

#[cfg(not(debug_assertions))]
#[derive(RustEmbed)]
#[folder = "frontend/dist/"]
struct FrontendAsset;

#[cfg(debug_assertions)]
pub fn router(vite_origin: &str) -> Router<Arc<AppState>> {
    Router::new().merge(ReverseProxy::new("/", vite_origin))
}

#[cfg(not(debug_assertions))]
pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/", get(index)).fallback(get(asset))
}

#[cfg(not(debug_assertions))]
async fn index() -> Response<Body> {
    serve_asset("index.html").unwrap_or_else(not_found)
}

#[cfg(not(debug_assertions))]
async fn asset(uri: Uri) -> Response<Body> {
    let path = uri.path().trim_start_matches('/');

    if path.is_empty() {
        return index().await;
    }

    if path.starts_with("imports")
        || path.starts_with("address_lookup")
        || path.starts_with("identify")
        || path.starts_with("tiles")
        || matches!(path, "healthz" | "readyz" | "metrics" | "tiles.json")
    {
        return not_found();
    }

    serve_asset(path)
        .or_else(|| serve_asset("index.html"))
        .unwrap_or_else(not_found)
}

#[cfg(not(debug_assertions))]
fn serve_asset(path: &str) -> Option<Response<Body>> {
    let asset = FrontendAsset::get(path)?;
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    let mut response = Response::new(Body::from(asset.data.into_owned()));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(mime.as_ref()).ok()?,
    );
    Some(response)
}

#[cfg(not(debug_assertions))]
fn not_found() -> Response<Body> {
    StatusCode::NOT_FOUND.into_response()
}
