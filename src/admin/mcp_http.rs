//! HTTP transport for the MCP server.
//!
//! Mounts the MCP **Streamable HTTP** transport (per the MCP 2025-03-26
//! spec) at `/mcp` on the same axum [`Router`] that serves the admin UI.
//! AI clients can connect over HTTP/SSE while the container runs as a
//! long-lived daemon — without ever attaching stdio.
//!
//! # Auth boundary
//!
//! Protected by the same `MAIL_MCP_ADMIN_TOKEN` that gates the admin UI.
//! When no token is configured the server only binds to loopback, so
//! /mcp is also loopback-only and unauthenticated by design.
//!
//! # Hot reload
//!
//! Each new MCP session creates a fresh [`MailImapServer`] from a snapshot
//! of [`ConfigManager::config`]. New sessions therefore see the latest
//! config; in-flight sessions keep their snapshot until the client
//! reconnects.

use std::sync::Arc;
use std::time::Duration;

use axum::Json;
use axum::Router;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use serde_json::json;

use super::AdminState;
use crate::server::MailImapServer;

/// Build the MCP HTTP sub-router.
///
/// The single tower service handles `POST /mcp`, `GET /mcp`, and
/// `DELETE /mcp` per the MCP Streamable HTTP spec. The same service is
/// also exposed at `/mcp/` so trailing-slash clients work.
///
/// Returns `None` when HTTP MCP is disabled via env, so the caller can
/// skip the `merge` and avoid registering routes.
pub fn router(state: AdminState) -> Option<Router<AdminState>> {
    if !is_enabled() {
        return None;
    }

    let cfg_mgr = state.config_manager.clone();
    let session_manager = Arc::new(LocalSessionManager::default());
    let service_factory = move || -> Result<MailImapServer, std::io::Error> {
        let cfg = (*cfg_mgr.config()).clone();
        Ok(MailImapServer::new(cfg, None))
    };

    let service = StreamableHttpService::new(
        service_factory,
        session_manager,
        StreamableHttpServerConfig {
            sse_keep_alive: Some(Duration::from_secs(15)),
            sse_retry: Some(Duration::from_secs(3)),
            stateful_mode: true,
            ..Default::default()
        },
    );

    let router = Router::<AdminState>::new()
        .route_service("/mcp", service.clone())
        .route_service("/mcp/", service)
        .layer(middleware::from_fn_with_state(state, require_mcp_auth));

    Some(router)
}

/// Whether HTTP MCP should be enabled. Defaults to `true` when the admin
/// server is running; set `MAIL_MCP_HTTP_ENABLED=false` to opt out.
pub fn is_enabled() -> bool {
    match std::env::var("MAIL_MCP_HTTP_ENABLED") {
        Ok(v) => matches!(
            v.to_ascii_lowercase().trim(),
            "1" | "true" | "yes" | "on"
        ),
        Err(_) => true,
    }
}

/// Bearer-token guard. Mirrors `routes::require_auth` so the admin token
/// works for both the UI and the MCP transport.
async fn require_mcp_auth(
    State(state): State<AdminState>,
    headers: HeaderMap,
    req: Request,
    next: Next,
) -> Response {
    if let Some(expected) = state.settings.admin_token.as_deref() {
        let provided = headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.strip_prefix("Bearer "))
            .map(str::trim)
            .unwrap_or("");
        if provided.is_empty() || !ct_eq(provided, expected) {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({"error": "unauthorized"})),
            )
                .into_response();
        }
    }
    next.run(req).await
}

fn ct_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.bytes().zip(b.bytes()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_enabled_by_default() {
        let _g = EnvLock::new("MAIL_MCP_HTTP_ENABLED", None);
        assert!(is_enabled());
    }

    #[test]
    fn http_can_be_disabled_via_env() {
        let _g = EnvLock::new("MAIL_MCP_HTTP_ENABLED", Some("false"));
        assert!(!is_enabled());
    }

    #[test]
    fn ct_eq_constant_time_matches() {
        assert!(ct_eq("abc", "abc"));
        assert!(!ct_eq("abc", "abd"));
        assert!(!ct_eq("abc", "abcd"));
    }

    struct EnvLock {
        key: &'static str,
        previous: Option<String>,
    }
    impl EnvLock {
        fn new(key: &'static str, value: Option<&str>) -> Self {
            let previous = std::env::var(key).ok();
            unsafe {
                match value {
                    Some(v) => std::env::set_var(key, v),
                    None => std::env::remove_var(key),
                }
            }
            Self { key, previous }
        }
    }
    impl Drop for EnvLock {
        fn drop(&mut self) {
            unsafe {
                match &self.previous {
                    Some(v) => std::env::set_var(self.key, v),
                    None => std::env::remove_var(self.key),
                }
            }
        }
    }
}
