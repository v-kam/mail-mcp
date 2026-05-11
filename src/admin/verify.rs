//! Connectivity verification for the admin UI.
//!
//! Performs lightweight liveness checks against each protocol an account
//! configures:
//!
//! - **IMAP** — TCP/TLS connect, LOGIN/XOAUTH2, single NOOP
//! - **SMTP** — TCP/TLS handshake + AUTH (no message sent)
//! - **Graph API** — refresh OAuth2 access token (proves credentials)
//! - **EWS** — refresh OAuth2 access token
//!
//! The functions are intentionally short and reuse the existing transport
//! modules so that what works in the MCP tools also works here.

use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::config::ServerConfig;
use crate::errors::{AppError, AppResult};
use crate::oauth2::TokenManager;

/// Per-protocol verify result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProtocolVerify {
    pub protocol: String,
    pub ok: bool,
    pub latency_ms: u64,
    pub error: Option<String>,
}

/// Aggregate verify result for an account.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountVerifyResult {
    pub account_id: String,
    pub overall_ok: bool,
    pub protocols: Vec<ProtocolVerify>,
}

/// Verify every configured protocol for `account_id`. Returns an error
/// only when the account does not exist; per-protocol failures are
/// reported as `ok = false` inside the response.
pub async fn verify_account(
    config: &ServerConfig,
    imap_smtp_token_manager: Option<&TokenManager>,
    graph_token_manager: Option<&TokenManager>,
    ews_token_manager: Option<&TokenManager>,
    account_id: &str,
) -> AppResult<AccountVerifyResult> {
    let mut protocols = Vec::new();

    let has_imap = config.accounts.contains_key(account_id);
    let has_smtp = config.smtp_accounts.contains_key(account_id);
    let has_graph = config.graph_oauth2_accounts.contains_key(account_id)
        || imap_smtp_token_manager.is_some_and(|tm| tm.has_oauth2(account_id))
            && graph_token_manager.is_some_and(|tm| tm.has_oauth2(account_id));
    let has_ews = config.ews_accounts.contains_key(account_id);

    if !(has_imap || has_smtp || has_graph || has_ews) {
        return Err(AppError::NotFound(format!(
            "account '{account_id}' is not configured"
        )));
    }

    if has_imap {
        protocols.push(verify_imap(config, imap_smtp_token_manager, account_id).await);
    }
    if has_smtp {
        protocols.push(verify_smtp(config, imap_smtp_token_manager, account_id).await);
    }
    if has_graph {
        let tm = graph_token_manager.or(imap_smtp_token_manager);
        protocols.push(verify_token(tm, account_id, "graph").await);
    }
    if has_ews {
        protocols.push(verify_token(ews_token_manager, account_id, "ews").await);
    }

    let overall_ok = !protocols.is_empty() && protocols.iter().all(|p| p.ok);

    Ok(AccountVerifyResult {
        account_id: account_id.to_owned(),
        overall_ok,
        protocols,
    })
}

async fn verify_imap(
    config: &ServerConfig,
    token_manager: Option<&TokenManager>,
    account_id: &str,
) -> ProtocolVerify {
    let started = Instant::now();
    let result: AppResult<()> = async {
        let account = config.get_account(account_id)?;
        let mut session = crate::imap::connect_authenticated(config, account, token_manager).await?;
        crate::imap::noop(config, &mut session).await?;
        let _ = session.logout().await;
        Ok(())
    }
    .await;

    ProtocolVerify {
        protocol: "imap".into(),
        ok: result.is_ok(),
        latency_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
        error: result.err().map(|e| e.to_string()),
    }
}

async fn verify_smtp(
    config: &ServerConfig,
    token_manager: Option<&TokenManager>,
    account_id: &str,
) -> ProtocolVerify {
    let started = Instant::now();
    let result: AppResult<()> = async {
        let smtp_config = config.get_smtp_account(account_id)?;
        crate::smtp::verify_smtp(smtp_config, token_manager, config.smtp_connect_timeout_ms).await
    }
    .await;

    ProtocolVerify {
        protocol: "smtp".into(),
        ok: result.is_ok(),
        latency_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
        error: result.err().map(|e| e.to_string()),
    }
}

async fn verify_token(
    token_manager: Option<&TokenManager>,
    account_id: &str,
    label: &str,
) -> ProtocolVerify {
    let started = Instant::now();
    let result: AppResult<()> = async {
        let tm = token_manager.ok_or_else(|| {
            AppError::InvalidInput(format!(
                "no OAuth2 token manager available for {label} account '{account_id}'"
            ))
        })?;
        tm.get_access_token(account_id).await.map(|_| ())
    }
    .await;

    ProtocolVerify {
        protocol: label.into(),
        ok: result.is_ok(),
        latency_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
        error: result.err().map(|e| e.to_string()),
    }
}
