//! Admin HTTP server for the management UI and MCP HTTP transport.
//!
//! This module owns the embedded React management UI, its REST API, and
//! the MCP "Streamable HTTP" transport mounted at `/mcp`. Runs in the
//! same process as the stdio MCP transport so a single `mail-mcp`
//! container can serve AI clients over either stdio (one-shot) or HTTP
//! (long-lived daemon).
//!
//! Exposes endpoints to read/write account configuration (with encrypted
//! persistence in SQLite), trigger connectivity verification, read
//! tool-usage analytics, and accept MCP traffic from remote AI clients.
//!
//! # Modules
//!
//! - [`config_manager`]: Hot-swappable [`ServerConfig`] + token managers
//! - [`mcp_http`]: MCP Streamable HTTP transport mounted at `/mcp`
//! - [`routes`]: Axum REST handlers under `/api/*`
//! - [`stats`]: Per-tool invocation counters fed from `finalize_tool`
//! - [`store`]: SQLite persistence with AEAD-encrypted secrets
//! - [`static_files`]: Embedded React build served via `rust-embed`
//! - [`verify`]: Reusable connectivity verification (IMAP/SMTP/Graph/EWS)

pub mod config_manager;
pub mod mcp_http;
pub mod routes;
pub mod stats;
pub mod store;
pub mod static_files;
pub mod verify;

use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

pub use config_manager::ConfigManager;
pub use stats::ToolStatsRegistry;
pub use store::AccountStore;

use crate::errors::{AppError, AppResult};

/// Runtime settings for the admin HTTP server.
///
/// Loaded from environment variables. The presence of an
/// [`AdminSettings`] (returned as `Some` from
/// [`AdminSettings::from_env`]) is itself the "admin enabled" signal —
/// callers receive `None` when admin is not requested.
#[derive(Debug, Clone)]
pub struct AdminSettings {
    /// Bind address (e.g. `127.0.0.1:8080` or `0.0.0.0:8080`).
    pub bind_addr: SocketAddr,
    /// Optional bearer token. Required when `bind_addr` is non-loopback.
    pub admin_token: Option<String>,
    /// Optional master encryption key for at-rest secrets. When unset, the
    /// store opens in read-only/verify-only mode (no writes accepted).
    pub admin_key: Option<String>,
    /// SQLite database path (e.g. `/data/mail-mcp.db`).
    pub data_path: std::path::PathBuf,
}

impl AdminSettings {
    /// Load admin settings from environment variables.
    ///
    /// Returns `Ok(None)` when admin is explicitly disabled via
    /// `MAIL_MCP_ADMIN_ENABLED=false`, OR when no `MAIL_MCP_ADMIN_*` env
    /// variables are present at all (legacy stdio-only mode).
    pub fn from_env() -> AppResult<Option<Self>> {
        let explicitly_disabled = std::env::var("MAIL_MCP_ADMIN_ENABLED")
            .ok()
            .map(|v| matches!(v.to_ascii_lowercase().trim(), "0" | "false" | "no" | "off"))
            .unwrap_or(false);
        if explicitly_disabled {
            return Ok(None);
        }

        // Enable the admin UI when any *admin* env var is set. Plain
        // MAIL_MCP_DATA_DIR is treated as a path override only and does
        // not by itself enable the UI, so users wiring the env var for
        // future use don't get a surprise listener.
        let port_set = std::env::var("MAIL_MCP_ADMIN_PORT").is_ok();
        let token_set = std::env::var("MAIL_MCP_ADMIN_TOKEN").is_ok();
        let key_set = std::env::var("MAIL_MCP_ADMIN_KEY").is_ok();
        let enabled_via_flag = std::env::var("MAIL_MCP_ADMIN_ENABLED")
            .ok()
            .map(|v| matches!(v.to_ascii_lowercase().trim(), "1" | "true" | "yes" | "on"))
            .unwrap_or(false);

        if !(port_set || token_set || key_set || enabled_via_flag) {
            return Ok(None);
        }

        let port: u16 = std::env::var("MAIL_MCP_ADMIN_PORT")
            .ok()
            .map(|v| {
                v.parse().map_err(|_| {
                    AppError::InvalidInput(format!("MAIL_MCP_ADMIN_PORT must be a u16, got '{v}'"))
                })
            })
            .transpose()?
            .unwrap_or(8080);

        let bind_host = std::env::var("MAIL_MCP_ADMIN_HOST").unwrap_or_else(|_| {
            // Default to 0.0.0.0 only if a token is set (safe by default).
            if std::env::var("MAIL_MCP_ADMIN_TOKEN").is_ok() {
                "0.0.0.0".to_owned()
            } else {
                "127.0.0.1".to_owned()
            }
        });

        let bind_addr: SocketAddr = format!("{bind_host}:{port}").parse().map_err(|e| {
            AppError::InvalidInput(format!(
                "invalid MAIL_MCP_ADMIN_HOST/MAIL_MCP_ADMIN_PORT combination: {e}"
            ))
        })?;

        let admin_token = std::env::var("MAIL_MCP_ADMIN_TOKEN")
            .ok()
            .filter(|v| !v.trim().is_empty());

        // Refuse to bind to non-loopback without a token. This is the single
        // hardest guarantee the admin server provides.
        if !bind_addr.ip().is_loopback() && admin_token.is_none() {
            return Err(AppError::InvalidInput(format!(
                "refusing to bind admin UI on {bind_addr} without MAIL_MCP_ADMIN_TOKEN \
                 (set the token, or bind to 127.0.0.1)"
            )));
        }

        let admin_key = std::env::var("MAIL_MCP_ADMIN_KEY")
            .ok()
            .filter(|v| !v.trim().is_empty());

        let data_path = std::env::var("MAIL_MCP_DATA_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| std::path::PathBuf::from("/data"))
            .join("mail-mcp.db");

        Ok(Some(Self {
            bind_addr,
            admin_token,
            admin_key,
            data_path,
        }))
    }
}

/// Shared application state passed to every axum handler.
///
/// The store is reachable through `config_manager.store()`; it lives on
/// the manager so a single source of truth applies to both runtime
/// config rebuilds and direct queries.
#[derive(Clone)]
pub struct AdminState {
    pub config_manager: Arc<ConfigManager>,
    pub stats: Arc<ToolStatsRegistry>,
    pub settings: Arc<AdminSettings>,
    pub version: &'static str,
}

/// Build the axum [`Router`] without binding it. Useful for tests.
///
/// Routes:
/// - `/api/*`        admin REST API (bearer-token gated)
/// - `/mcp`, `/mcp/` MCP Streamable HTTP transport (bearer-token gated)
/// - everything else SPA fallback (admin UI assets)
pub fn build_router(state: AdminState) -> Router {
    let mut router = Router::new().nest("/api", routes::api_router(state.clone()));

    if let Some(mcp) = mcp_http::router(state.clone()) {
        router = router.merge(mcp);
    }

    router
        .fallback(static_files::handler)
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

/// Bind to the configured address and serve the admin UI.
///
/// Returns when the listener accepts a shutdown signal (`Ctrl-C`) or the
/// caller cancels via the parent task.
pub async fn serve(state: AdminState) -> AppResult<()> {
    let bind = state.settings.bind_addr;
    let app = build_router(state);

    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .map_err(|e| AppError::Internal(format!("failed to bind admin UI on {bind}: {e}")))?;

    if mcp_http::is_enabled() {
        tracing::info!(
            "admin UI listening on http://{bind} (MCP HTTP at http://{bind}/mcp)"
        );
    } else {
        tracing::info!("admin UI listening on http://{bind} (MCP HTTP disabled)");
    }

    axum::serve(listener, app.into_make_service())
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .map_err(|e| AppError::Internal(format!("admin UI server error: {e}")))?;

    Ok(())
}
