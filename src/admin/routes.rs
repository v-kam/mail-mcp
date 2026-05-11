//! REST handlers for the admin UI under `/api/*`.
//!
//! All routes are guarded by [`require_auth`] (bearer token) when an
//! `MAIL_MCP_ADMIN_TOKEN` is configured. Routes that mutate the store
//! additionally require the store to be writable (i.e.
//! `MAIL_MCP_ADMIN_KEY` is set) — otherwise they return 400 with a clear
//! explanation.

use axum::Json;
use axum::Router;
use axum::extract::{Path, Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::AdminState;
use super::store::{StoredAccount, StoredSettings, VerifyOutcome};
use super::verify::{AccountVerifyResult, verify_account};

/// Build the `/api` sub-router.
///
/// `/api/health` is intentionally placed *outside* the auth layer so the
/// SPA can learn whether a token is required before showing the login
/// screen. Every other endpoint goes through [`require_auth`].
pub fn api_router(state: AdminState) -> Router<AdminState> {
    let authed = Router::new()
        .route("/auth/check", get(auth_check))
        .route("/tools", get(list_tools))
        .route("/analytics", get(analytics))
        .route("/settings", get(get_settings).post(set_settings))
        .route("/accounts", get(list_accounts).post(upsert_account))
        .route(
            "/accounts/:id",
            get(get_account).put(upsert_account_with_id).delete(delete_account),
        )
        .route("/accounts/:id/verify", post(post_verify))
        .layer(middleware::from_fn_with_state(state, require_auth));

    Router::new().route("/health", get(health)).merge(authed)
}

// ─── Auth middleware ────────────────────────────────────────────────────────

/// Extract bearer token from the `Authorization` header. Returns `None`
/// when the header is missing or malformed.
fn extract_bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .map(str::trim)
}

async fn require_auth(
    State(state): State<AdminState>,
    headers: HeaderMap,
    req: Request,
    next: Next,
) -> Response {
    if let Some(expected) = state.settings.admin_token.as_deref() {
        let provided = extract_bearer(&headers).unwrap_or("");
        if !ct_eq(provided, expected) {
            return (StatusCode::UNAUTHORIZED, Json(json!({"error": "unauthorized"})))
                .into_response();
        }
    }
    next.run(req).await
}

/// Constant-time string equality to avoid timing oracles on the token.
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

// ─── Error mapping ──────────────────────────────────────────────────────────

struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error": self.1}))).into_response()
    }
}

impl From<crate::errors::AppError> for ApiError {
    fn from(e: crate::errors::AppError) -> Self {
        use crate::errors::AppError;
        let status = match &e {
            AppError::InvalidInput(_) => StatusCode::BAD_REQUEST,
            AppError::NotFound(_) => StatusCode::NOT_FOUND,
            AppError::AuthFailed(_) => StatusCode::UNAUTHORIZED,
            AppError::Conflict(_) => StatusCode::CONFLICT,
            AppError::Timeout(_) | AppError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        ApiError(status, e.to_string())
    }
}

type ApiResult<T> = Result<T, ApiError>;

// ─── Routes ────────────────────────────────────────────────────────────────

async fn health(State(state): State<AdminState>) -> Json<Value> {
    let writable = state.config_manager.store().is_some_and(|s| s.writable());
    let admin_token_set = state.settings.admin_token.is_some();
    Json(json!({
        "status": "ok",
        "version": state.version,
        "store_writable": writable,
        "admin_token_required": admin_token_set,
        "mcp_http_enabled": super::mcp_http::is_enabled(),
        "mcp_http_path": "/mcp",
    }))
}

async fn auth_check() -> Json<Value> {
    Json(json!({"ok": true}))
}

async fn list_tools(State(state): State<AdminState>) -> Json<Value> {
    let tools: Vec<Value> = crate::server::tool_catalog()
        .into_iter()
        .map(|(name, description)| json!({"name": name, "description": description}))
        .collect();
    let snapshot = state.stats.snapshot();
    Json(json!({
        "tools": tools,
        "stats": snapshot,
    }))
}

async fn analytics(State(state): State<AdminState>) -> Json<Value> {
    let stats = state.stats.snapshot();
    let entries: Vec<Value> = stats
        .into_iter()
        .map(|(name, s)| {
            json!({
                "name": name,
                "total_calls": s.total_calls,
                "errors": s.errors,
                "avg_duration_ms": s.avg_duration_ms(),
                "max_duration_ms": s.max_duration_ms,
                "last_called_at": s.last_called_at,
            })
        })
        .collect();
    Json(json!({"tools": entries}))
}

async fn get_settings(State(state): State<AdminState>) -> ApiResult<Json<Value>> {
    let cfg = state.config_manager.config();
    let stored = state
        .config_manager
        .store()
        .map(|s| s.get_settings())
        .transpose()?
        .unwrap_or_default();

    Ok(Json(json!({
        "imap_write_enabled": cfg.write_enabled,
        "smtp_write_enabled": cfg.smtp_write_enabled,
        "smtp_save_sent": cfg.smtp_save_sent,
        "imap_connect_timeout_ms": cfg.connect_timeout_ms,
        "imap_socket_timeout_ms": cfg.socket_timeout_ms,
        "smtp_connect_timeout_ms": cfg.smtp_connect_timeout_ms,
        "smtp_send_timeout_ms": cfg.smtp_send_timeout_ms,
        "stored_overrides": {
            "imap_write_enabled": stored.imap_write_enabled,
            "smtp_write_enabled": stored.smtp_write_enabled,
        }
    })))
}

#[derive(Debug, Deserialize)]
struct SettingsPatch {
    imap_write_enabled: Option<bool>,
    smtp_write_enabled: Option<bool>,
}

async fn set_settings(
    State(state): State<AdminState>,
    Json(body): Json<SettingsPatch>,
) -> ApiResult<Json<Value>> {
    let store = state.config_manager.store().ok_or_else(|| {
        ApiError(
            StatusCode::BAD_REQUEST,
            "no persistent store; settings cannot be overridden at runtime".to_owned(),
        )
    })?;
    store.set_settings(&StoredSettings {
        imap_write_enabled: body.imap_write_enabled,
        smtp_write_enabled: body.smtp_write_enabled,
    })?;
    state.config_manager.reload()?;
    Ok(Json(json!({"ok": true})))
}

async fn list_accounts(State(state): State<AdminState>) -> ApiResult<Json<Value>> {
    let cfg = state.config_manager.config();
    let stored = match state.config_manager.store() {
        Some(s) => s.list_accounts(false)?,
        None => env_accounts_to_stored(&cfg),
    };

    let view: Vec<Value> = stored
        .into_iter()
        .map(|s| account_summary(&s, &cfg))
        .collect();

    Ok(Json(json!({
        "accounts": view,
        "store_writable": state.config_manager.store().is_some_and(|s| s.writable()),
    })))
}

async fn get_account(
    State(state): State<AdminState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let cfg = state.config_manager.config();
    let stored = match state.config_manager.store() {
        Some(s) => s.get_account(&id, false)?.ok_or_else(|| {
            ApiError(StatusCode::NOT_FOUND, format!("account '{id}' not found"))
        })?,
        None => env_accounts_to_stored(&cfg)
            .into_iter()
            .find(|a| a.account_id == id)
            .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, format!("account '{id}' not found")))?,
    };
    Ok(Json(account_summary(&stored, &cfg)))
}

async fn upsert_account(
    State(state): State<AdminState>,
    Json(payload): Json<StoredAccount>,
) -> ApiResult<Json<Value>> {
    do_upsert(state, payload).await
}

async fn upsert_account_with_id(
    State(state): State<AdminState>,
    Path(id): Path<String>,
    Json(mut payload): Json<StoredAccount>,
) -> ApiResult<Json<Value>> {
    if payload.account_id.is_empty() {
        payload.account_id = id;
    } else if payload.account_id != id {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "URL account id and body account_id mismatch".to_owned(),
        ));
    }
    do_upsert(state, payload).await
}

async fn do_upsert(state: AdminState, payload: StoredAccount) -> ApiResult<Json<Value>> {
    if payload.account_id.trim().is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "account_id is required".to_owned(),
        ));
    }
    if !payload
        .account_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "account_id must match ^[A-Za-z0-9_-]+$".to_owned(),
        ));
    }
    let store = state.config_manager.store().ok_or_else(|| {
        ApiError(
            StatusCode::BAD_REQUEST,
            "admin store is not writable; set MAIL_MCP_ADMIN_KEY".to_owned(),
        )
    })?;
    if !store.writable() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "admin store is read-only; set MAIL_MCP_ADMIN_KEY to enable writes".to_owned(),
        ));
    }
    store.upsert_account(&payload)?;
    state.config_manager.reload()?;
    Ok(Json(json!({"ok": true, "account_id": payload.account_id})))
}

async fn delete_account(
    State(state): State<AdminState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let store = state.config_manager.store().ok_or_else(|| {
        ApiError(
            StatusCode::BAD_REQUEST,
            "admin store is not writable; set MAIL_MCP_ADMIN_KEY".to_owned(),
        )
    })?;
    let deleted = store.delete_account(&id)?;
    state.config_manager.reload()?;
    Ok(Json(json!({"ok": true, "deleted": deleted})))
}

async fn post_verify(
    State(state): State<AdminState>,
    Path(id): Path<String>,
) -> ApiResult<Json<AccountVerifyResult>> {
    let cfg = state.config_manager.config();
    let imap_smtp_tm = state.config_manager.imap_smtp_token_manager();
    let graph_tm = state.config_manager.graph_token_manager();
    let ews_tm = state.config_manager.ews_token_manager();

    let result = verify_account(
        &cfg,
        imap_smtp_tm.as_ref().as_ref(),
        graph_tm.as_ref().as_ref(),
        ews_tm.as_ref().as_ref(),
        &id,
    )
    .await?;

    if let Some(store) = state.config_manager.store() {
        let outcome = VerifyOutcome {
            status: if result.overall_ok { "ok".into() } else { "error".into() },
            error: result
                .protocols
                .iter()
                .find(|p| !p.ok)
                .and_then(|p| p.error.clone()),
        };
        let _ = store.set_verify_result(&id, &outcome);
    }

    Ok(Json(result))
}

// ─── Helpers ────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
struct AccountSummary {
    account_id: String,
    display_name: Option<String>,
    user: Option<String>,
    capabilities: Capabilities,
    last_verify_status: Option<String>,
    last_verify_error: Option<String>,
    last_verify_at_ms: Option<i64>,
    imap: Option<ImapView>,
    smtp: Option<SmtpView>,
    oauth2: Option<OAuthView>,
    graph: Option<OAuthView>,
    ews: Option<EwsView>,
}

#[derive(Debug, Serialize, Default)]
struct Capabilities {
    imap: bool,
    smtp: bool,
    graph: bool,
    ews: bool,
}

#[derive(Debug, Serialize)]
struct ImapView {
    host: String,
    port: u16,
    user: String,
    secure: bool,
    auth: &'static str,
}

#[derive(Debug, Serialize)]
struct SmtpView {
    host: String,
    port: u16,
    user: String,
    security: String,
    auth: &'static str,
}

#[derive(Debug, Serialize)]
struct OAuthView {
    provider: String,
    client_id: String,
    has_refresh_token: bool,
}

#[derive(Debug, Serialize)]
struct EwsView {
    user: String,
    has_refresh_token: bool,
}

fn account_summary(stored: &StoredAccount, cfg: &crate::config::ServerConfig) -> Value {
    let runtime = cfg.accounts.get(&stored.account_id);
    let runtime_smtp = cfg.smtp_accounts.get(&stored.account_id);

    let imap = stored.imap_host.as_deref().map(|h| ImapView {
        host: h.to_owned(),
        port: stored.imap_port.unwrap_or(993),
        user: stored.imap_user.clone().unwrap_or_default(),
        secure: stored.imap_secure.unwrap_or(true),
        auth: match runtime.map(|a| a.auth_method) {
            Some(crate::config::AuthMethod::OAuth2) => "oauth2",
            _ => "password",
        },
    });

    let smtp = stored.smtp_host.as_deref().map(|h| SmtpView {
        host: h.to_owned(),
        port: stored.smtp_port.unwrap_or(587),
        user: stored.smtp_user.clone().unwrap_or_default(),
        security: stored.smtp_security.clone().unwrap_or_else(|| "starttls".into()),
        auth: match runtime_smtp.map(|a| a.auth_method) {
            Some(crate::config::AuthMethod::OAuth2) => "oauth2",
            _ => "password",
        },
    });

    let oauth2 = stored.oauth2_provider.as_deref().map(|p| OAuthView {
        provider: p.to_owned(),
        client_id: stored.oauth2_client_id.clone().unwrap_or_default(),
        has_refresh_token: cfg
            .oauth2_accounts
            .contains_key(&stored.account_id),
    });

    let graph = stored.graph_provider.as_deref().map(|p| OAuthView {
        provider: p.to_owned(),
        client_id: stored.graph_client_id.clone().unwrap_or_default(),
        has_refresh_token: cfg
            .graph_oauth2_accounts
            .contains_key(&stored.account_id),
    });

    let ews = stored.ews_user.as_deref().map(|u| EwsView {
        user: u.to_owned(),
        has_refresh_token: cfg.ews_oauth2_accounts.contains_key(&stored.account_id),
    });

    let summary = AccountSummary {
        account_id: stored.account_id.clone(),
        display_name: stored.display_name.clone(),
        user: stored
            .imap_user
            .clone()
            .or_else(|| stored.smtp_user.clone())
            .or_else(|| stored.ews_user.clone()),
        capabilities: Capabilities {
            imap: imap.is_some() && cfg.accounts.contains_key(&stored.account_id),
            smtp: smtp.is_some() && cfg.smtp_accounts.contains_key(&stored.account_id),
            graph: cfg.graph_oauth2_accounts.contains_key(&stored.account_id),
            ews: cfg.ews_accounts.contains_key(&stored.account_id),
        },
        last_verify_status: stored.last_verify_status.clone(),
        last_verify_error: stored.last_verify_error.clone(),
        last_verify_at_ms: stored.last_verify_at_ms,
        imap,
        smtp,
        oauth2,
        graph,
        ews,
    };

    serde_json::to_value(summary).unwrap_or_else(|_| json!({}))
}

/// Fallback when no store is configured: surface the env-derived
/// [`ServerConfig`] as read-only [`StoredAccount`] rows so the UI can
/// display them.
fn env_accounts_to_stored(cfg: &crate::config::ServerConfig) -> Vec<StoredAccount> {
    use std::collections::BTreeMap;
    let mut by_id: BTreeMap<String, StoredAccount> = BTreeMap::new();

    for (id, acc) in &cfg.accounts {
        let entry = by_id.entry(id.clone()).or_insert_with(|| StoredAccount {
            account_id: id.clone(),
            ..Default::default()
        });
        entry.imap_host = Some(acc.host.clone());
        entry.imap_port = Some(acc.port);
        entry.imap_user = Some(acc.user.clone());
        entry.imap_secure = Some(acc.secure);
    }
    for (id, acc) in &cfg.smtp_accounts {
        let entry = by_id.entry(id.clone()).or_insert_with(|| StoredAccount {
            account_id: id.clone(),
            ..Default::default()
        });
        entry.smtp_host = Some(acc.host.clone());
        entry.smtp_port = Some(acc.port);
        entry.smtp_user = Some(acc.user.clone());
        entry.smtp_security = Some(format!("{:?}", acc.security).to_ascii_lowercase());
    }
    for (id, oa) in &cfg.oauth2_accounts {
        let entry = by_id.entry(id.clone()).or_insert_with(|| StoredAccount {
            account_id: id.clone(),
            ..Default::default()
        });
        entry.oauth2_provider = Some(format!("{:?}", oa.provider).to_ascii_lowercase());
        entry.oauth2_client_id = Some(oa.client_id.clone());
    }
    for (id, oa) in &cfg.graph_oauth2_accounts {
        let entry = by_id.entry(id.clone()).or_insert_with(|| StoredAccount {
            account_id: id.clone(),
            ..Default::default()
        });
        entry.graph_provider = Some(format!("{:?}", oa.provider).to_ascii_lowercase());
        entry.graph_client_id = Some(oa.client_id.clone());
    }
    for (id, ews) in &cfg.ews_accounts {
        let entry = by_id.entry(id.clone()).or_insert_with(|| StoredAccount {
            account_id: id.clone(),
            ..Default::default()
        });
        entry.ews_user = Some(ews.user.clone());
    }
    by_id.into_values().collect()
}
