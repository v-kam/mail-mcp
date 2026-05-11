//! Embedded React build served from the binary.
//!
//! Uses [`rust_embed`] to compile every file under `frontend/dist/` into
//! the executable at build time. The handler implements an SPA fallback:
//! unknown paths return `index.html` so client-side routing works.
//!
//! When the React build directory is missing (e.g. running `cargo test`
//! before the UI is built), a small placeholder HTML is returned instead
//! of a 500 error.

use axum::body::Body;
use axum::extract::State;
use axum::http::{StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use rust_embed::RustEmbed;

use super::AdminState;

#[derive(RustEmbed)]
#[folder = "frontend/dist"]
struct Assets;

const PLACEHOLDER: &str = include_str!("placeholder.html");

/// Axum fallback handler — serves `index.html` (or the matched asset).
pub async fn handler(State(_state): State<AdminState>, uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let candidate = if path.is_empty() { "index.html" } else { path };

    if let Some(file) = Assets::get(candidate) {
        let mime = mime_guess::from_path(candidate).first_or_octet_stream();
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime.as_ref())
            .header(header::CACHE_CONTROL, cache_for(candidate))
            .body(Body::from(file.data.into_owned()))
            .unwrap_or_else(|_| internal_error());
    }

    // SPA fallback: any non-asset URL returns index.html so the React
    // router can take over.
    if let Some(file) = Assets::get("index.html") {
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .header(header::CACHE_CONTROL, "no-store")
            .body(Body::from(file.data.into_owned()))
            .unwrap_or_else(|_| internal_error());
    }

    // Frontend build is missing. Show a friendly placeholder so the API
    // is still usable and the user understands what to do.
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .body(Body::from(PLACEHOLDER))
        .unwrap_or_else(|_| internal_error())
}

fn cache_for(path: &str) -> &'static str {
    if path.starts_with("assets/") {
        // Vite emits hashed asset filenames so they can be cached forever.
        "public, max-age=31536000, immutable"
    } else {
        "no-store"
    }
}

fn internal_error() -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response()
}
