//! mail-mcp: Secure email MCP server with optional admin UI + HTTP transport
//!
//! This binary speaks the Model Context Protocol over **two transports**:
//!
//! - **stdio**: classic one-shot mode for CLIs and editor-spawned agents
//!   (Cursor, Claude Code, Claude Desktop launching the binary directly).
//! - **Streamable HTTP** (MCP 2025-03-26): for long-lived daemons, where
//!   the AI client connects to `http://host:8080/mcp` over the network.
//!
//! The same binary also exposes an embedded React admin UI on the same
//! HTTP port for adding/verifying mail accounts and viewing per-tool
//! usage analytics. HTTP MCP and the admin UI are gated by the same
//! bearer token (`MAIL_MCP_ADMIN_TOKEN`) when set.
//!
//! # Architecture
//!
//! - [`main`]: process bootstrap, env loading, tracing, dual transport
//! - [`config`]: env-driven [`ServerConfig`](config::ServerConfig)
//! - [`admin`]: SQLite-backed account store, hot-swappable
//!   [`ConfigManager`](admin::ConfigManager), HTTP server, MCP HTTP
//!   transport, tool analytics
//! - [`server`]: MCP tool router + handlers
//! - [`imap`], [`smtp`], [`graph`], [`ews`], [`oauth2`]: transport modules
//! - [`mime`], [`message_id`], [`pagination`]: parsing/state helpers
//! - [`errors`]: typed error model + MCP `ErrorData` mapping

mod admin;
mod config;
mod errors;
mod ews;
mod graph;
mod imap;
mod message_id;
mod mime;
mod models;
mod oauth2;
mod pagination;
mod server;
mod smtp;

use std::collections::BTreeMap;
use std::io::{self, Write};
use std::sync::Arc;

use admin::{AdminSettings, AdminState, AccountStore, ConfigManager, ToolStatsRegistry};
use config::ServerConfig;
use rmcp::ServiceExt;
use rmcp::transport::stdio;
use tracing_subscriber::EnvFilter;

/// Application entry point.
///
/// 1. Loads tracing + env files
/// 2. Builds [`ServerConfig`] from env vars
/// 3. Optionally opens the SQLite store and starts the admin HTTP server
/// 4. Starts the MCP stdio transport (always)
///
/// When the admin server is enabled, the process runs both transports
/// concurrently and stays alive until either exits.
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _ = rustls::crypto::ring::default_provider().install_default();

    dotenvy::dotenv().ok();

    if should_print_help(std::env::args().skip(1)) {
        print_help_output()?;
        return Ok(());
    }

    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();

    tracing::info!(version = env!("CARGO_PKG_VERSION"), "starting mail-mcp");

    let env_config = ServerConfig::load_from_env().or_else(|e| {
        // Allow startup with no accounts when the admin UI is enabled —
        // the user will configure accounts through the UI on first run.
        let admin_settings = AdminSettings::from_env().ok().flatten();
        if admin_settings.is_some() {
            tracing::warn!(
                "starting with no env-configured accounts; the admin UI will let you add some: {e}"
            );
            Ok(empty_server_config())
        } else {
            Err(e)
        }
    })?;

    let admin_settings = AdminSettings::from_env()?;
    let store: Option<Arc<AccountStore>> = match &admin_settings {
        Some(s) => Some(Arc::new(AccountStore::open(
            &s.data_path,
            s.admin_key.as_deref(),
        )?)),
        None => None,
    };

    let config_manager = Arc::new(ConfigManager::new(env_config, store.clone())?);
    let runtime_config: ServerConfig = (*config_manager.config()).clone();

    let stats = Arc::new(ToolStatsRegistry::new());
    server::set_tool_stats(stats.clone());

    let update_notice = if should_check_for_updates(admin_settings.is_some()) {
        check_for_updates().await
    } else {
        None
    };

    let mcp_server = server::MailImapServer::new(runtime_config, update_notice);

    match admin_settings {
        Some(settings) => {
            run_with_admin(mcp_server, config_manager, stats, settings).await?;
        }
        None => {
            run_stdio_only(mcp_server).await?;
        }
    }

    Ok(())
}

/// Run only the stdio MCP transport (legacy mode, no admin UI).
async fn run_stdio_only(server: server::MailImapServer) -> Result<(), Box<dyn std::error::Error>> {
    let service = server.serve(stdio()).await?;
    service.waiting().await?;
    Ok(())
}

/// Run both the stdio MCP transport and the admin HTTP server. Returns
/// when either side exits (typically `Ctrl-C`).
async fn run_with_admin(
    server: server::MailImapServer,
    config_manager: Arc<ConfigManager>,
    stats: Arc<ToolStatsRegistry>,
    settings: AdminSettings,
) -> Result<(), Box<dyn std::error::Error>> {
    let admin_state = AdminState {
        config_manager: config_manager.clone(),
        stats,
        settings: Arc::new(settings),
        version: env!("CARGO_PKG_VERSION"),
    };

    // Run stdio MCP in the background so that a closed stdin (typical
    // when the container is started as a daemon for the admin UI) does
    // not also terminate the admin HTTP server. The admin server is the
    // primary task; stdio exits silently when no MCP client is attached.
    let stdio_task = tokio::spawn(async move {
        if let Err(e) = run_stdio_only(server).await {
            tracing::warn!("stdio MCP transport ended: {e}");
        }
    });

    let admin_result = admin::serve(admin_state).await;
    stdio_task.abort();
    admin_result.map_err(|e| Box::new(e) as Box<dyn std::error::Error>)?;
    Ok(())
}

/// Whether to perform a startup update check. Skipped when the admin UI
/// is enabled (the UI surfaces the version + update banner instead) or
/// when `MAIL_MCP_UPDATE_CHECK=false` is set explicitly.
fn should_check_for_updates(admin_enabled: bool) -> bool {
    if let Ok(v) = std::env::var("MAIL_MCP_UPDATE_CHECK") {
        return matches!(
            v.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        );
    }
    !admin_enabled
}

/// Build a [`ServerConfig`] with no accounts. Used as a fallback when the
/// admin UI is enabled but `MAIL_*` env vars are not set — the UI will
/// let the user add accounts.
fn empty_server_config() -> ServerConfig {
    ServerConfig {
        accounts: BTreeMap::new(),
        oauth2_accounts: Default::default(),
        graph_oauth2_accounts: Default::default(),
        ews_accounts: Default::default(),
        ews_oauth2_accounts: Default::default(),
        smtp_accounts: Default::default(),
        smtp_write_enabled: false,
        smtp_save_sent: false,
        smtp_connect_timeout_ms: 30_000,
        smtp_send_timeout_ms: 300_000,
        write_enabled: false,
        connect_timeout_ms: 30_000,
        greeting_timeout_ms: 15_000,
        socket_timeout_ms: 300_000,
        cursor_ttl_seconds: 600,
        cursor_max_entries: 512,
    }
}

/// Check GitHub for newer releases. Returns a notice string if an update is available.
/// Times out after 2 seconds to avoid blocking startup.
async fn check_for_updates() -> Option<String> {
    let current = env!("CARGO_PKG_VERSION");
    let url = "https://api.github.com/repos/tecnologicachile/mail-mcp/releases/latest";

    let result = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        let client = reqwest::Client::new();
        let resp = client
            .get(url)
            .header("User-Agent", "mail-mcp")
            .header("Accept", "application/vnd.github.v3+json")
            .send()
            .await
            .ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let body: serde_json::Value = resp.json().await.ok()?;
        let latest_tag = body["tag_name"].as_str()?;
        let latest = latest_tag.trim_start_matches('v');
        if latest != current && latest > current {
            Some(format!(
                "\n\nUpdate available: v{current} -> {latest_tag}. \
                 See https://github.com/tecnologicachile/mail-mcp/releases/tag/{latest_tag}"
            ))
        } else {
            None
        }
    })
    .await;

    match result {
        Ok(notice) => {
            if let Some(ref msg) = notice {
                tracing::info!("update check: {msg}");
            } else {
                tracing::debug!("update check: running latest version v{current}");
            }
            notice
        }
        Err(_) => {
            tracing::debug!("update check: timed out (2s)");
            None
        }
    }
}

fn should_print_help<I>(args: I) -> bool
where
    I: IntoIterator,
    I::Item: AsRef<str>,
{
    args.into_iter().any(|arg| {
        let arg = arg.as_ref();
        arg == "--help" || arg == "-h"
    })
}

fn print_help_output() -> io::Result<()> {
    let env_map: BTreeMap<String, String> = std::env::vars().collect();
    let output = build_help_output(&env_map);
    let mut stdout = io::stdout().lock();
    stdout.write_all(output.as_bytes())?;
    stdout.flush()
}

fn build_help_output(env_map: &BTreeMap<String, String>) -> String {
    let account_sections = discover_account_sections(env_map);
    let mut out = String::new();

    out.push_str("mail-mcp\n");
    out.push_str("Secure email MCP server (stdio) with optional admin UI\n\n");

    out.push_str("Usage:\n");
    out.push_str("  mail-mcp\n");
    out.push_str("  mail-mcp --help\n\n");

    out.push_str("Admin UI / HTTP MCP environment\n");
    out.push_str("  MAIL_MCP_ADMIN_PORT       (default 8080 when admin enabled)\n");
    out.push_str("  MAIL_MCP_ADMIN_HOST       (default 127.0.0.1, or 0.0.0.0 if token set)\n");
    out.push_str("  MAIL_MCP_ADMIN_TOKEN      (required for non-loopback bind; gates UI + /mcp)\n");
    out.push_str("  MAIL_MCP_ADMIN_KEY        (master key used to encrypt secrets in SQLite)\n");
    out.push_str("  MAIL_MCP_DATA_DIR         (default /data; SQLite lives at <dir>/mail-mcp.db)\n");
    out.push_str("  MAIL_MCP_ADMIN_ENABLED    (true|false to force-enable/disable)\n");
    out.push_str("  MAIL_MCP_HTTP_ENABLED     (default true; set false to disable /mcp)\n");
    out.push_str("  MAIL_MCP_UPDATE_CHECK     (true|false; default false when admin is on)\n\n");

    out.push_str("MCP transports\n");
    out.push_str("  stdio: always available (run the binary; speak JSON-RPC over stdin/stdout)\n");
    out.push_str("  http : POST/GET/DELETE http://<host>:<port>/mcp (MCP Streamable HTTP)\n");
    out.push_str("  Both transports are served by the same process when the admin UI is on.\n\n");

    out.push_str("IMAP environment setup\n");
    out.push_str("  Required per account section MAIL_IMAP_<ACCOUNT>_:\n");
    out.push_str("    MAIL_IMAP_<ACCOUNT>_HOST\n");
    out.push_str("    MAIL_IMAP_<ACCOUNT>_USER\n");
    out.push_str("    MAIL_IMAP_<ACCOUNT>_PASS\n");
    out.push_str("  Optional per account section:\n");
    out.push_str("    MAIL_IMAP_<ACCOUNT>_PORT (default: 993)\n");
    out.push_str("    MAIL_IMAP_<ACCOUNT>_SECURE (default: true)\n\n");

    out.push_str("Discovered account sections (from current environment)\n");
    if account_sections.is_empty() {
        out.push_str("  (none discovered)\n");
    } else {
        for section in &account_sections {
            out.push_str(&format!("  [{}]\n", section));
            for suffix in ["HOST", "USER", "PASS", "PORT", "SECURE"] {
                let key = format!("MAIL_IMAP_{}_{}", section, suffix);
                let value = env_map.get(&key).map(String::as_str);
                out.push_str(&format!("    {}={}\n", key, redact_value(&key, value)));
            }
        }
    }
    out.push('\n');

    let oauth2_sections = discover_oauth2_sections(env_map);
    out.push_str("OAuth2 environment setup (optional, per account)\n");
    out.push_str("  MAIL_OAUTH2_<ACCOUNT>_PROVIDER    (google | microsoft)\n");
    out.push_str("  MAIL_OAUTH2_<ACCOUNT>_CLIENT_ID\n");
    out.push_str("  MAIL_OAUTH2_<ACCOUNT>_CLIENT_SECRET\n");
    out.push_str("  MAIL_OAUTH2_<ACCOUNT>_REFRESH_TOKEN\n\n");

    out.push_str("Discovered OAuth2 sections (from current environment)\n");
    if oauth2_sections.is_empty() {
        out.push_str("  (none discovered)\n");
    } else {
        for section in &oauth2_sections {
            out.push_str(&format!("  [{}]\n", section));
            for suffix in ["PROVIDER", "CLIENT_ID", "CLIENT_SECRET", "REFRESH_TOKEN"] {
                let key = format!("MAIL_OAUTH2_{}_{}", section, suffix);
                let value = env_map.get(&key).map(String::as_str);
                out.push_str(&format!("    {}={}\n", key, redact_value(&key, value)));
            }
        }
    }
    out.push('\n');

    let smtp_sections = discover_smtp_sections(env_map);
    out.push_str("SMTP environment setup (optional, per account)\n");
    out.push_str("  MAIL_SMTP_<ACCOUNT>_HOST\n");
    out.push_str("  MAIL_SMTP_<ACCOUNT>_PORT       (default: 587)\n");
    out.push_str("  MAIL_SMTP_<ACCOUNT>_USER\n");
    out.push_str("  MAIL_SMTP_<ACCOUNT>_PASS       (optional if OAuth2 configured)\n");
    out.push_str(
        "  MAIL_SMTP_<ACCOUNT>_SECURE     (starttls | tls | plain, default: starttls)\n\n",
    );

    out.push_str("Discovered SMTP sections (from current environment)\n");
    if smtp_sections.is_empty() {
        out.push_str("  (none discovered)\n");
    } else {
        for section in &smtp_sections {
            out.push_str(&format!("  [{}]\n", section));
            for suffix in ["HOST", "PORT", "USER", "PASS", "SECURE"] {
                let key = format!("MAIL_SMTP_{}_{}", section, suffix);
                let value = env_map.get(&key).map(String::as_str);
                out.push_str(&format!("    {}={}\n", key, redact_value(&key, value)));
            }
        }
    }
    out.push('\n');

    out.push_str("Global policy defaults\n");
    out.push_str("  MAIL_IMAP_WRITE_ENABLED=false\n");
    out.push_str("  MAIL_IMAP_CONNECT_TIMEOUT_MS=30000\n");
    out.push_str("  MAIL_IMAP_GREETING_TIMEOUT_MS=15000\n");
    out.push_str("  MAIL_IMAP_SOCKET_TIMEOUT_MS=300000\n");
    out.push_str("  MAIL_IMAP_CURSOR_TTL_SECONDS=600\n");
    out.push_str("  MAIL_IMAP_CURSOR_MAX_ENTRIES=512\n");
    out.push_str("  MAIL_SMTP_WRITE_ENABLED=false\n");
    out.push_str("  MAIL_SMTP_SAVE_SENT=true\n");
    out.push_str("  MAIL_SMTP_CONNECT_TIMEOUT_MS=30000\n");
    out.push_str("  MAIL_SMTP_SEND_TIMEOUT_MS=300000\n");
    out.push_str("  # MAIL_SMTP_TIMEOUT_MS (deprecated; use MAIL_SMTP_SEND_TIMEOUT_MS)\n\n");

    out.push_str("Send/write gate policy\n");
    out.push_str("  IMAP write tools are blocked unless MAIL_IMAP_WRITE_ENABLED=true.\n");
    out.push_str("  SMTP send tools are blocked unless MAIL_SMTP_WRITE_ENABLED=true.\n");
    out.push_str("  These gates can also be toggled at runtime through the admin UI.\n");

    out
}

fn discover_account_sections(env_map: &BTreeMap<String, String>) -> Vec<String> {
    let mut sections: Vec<String> = env_map
        .keys()
        .filter_map(|key| {
            let remainder = key.strip_prefix("MAIL_IMAP_")?;
            for suffix in ["_HOST", "_USER", "_PASS", "_PORT", "_SECURE"] {
                if let Some(section) = remainder.strip_suffix(suffix)
                    && !section.is_empty()
                {
                    return Some(section.to_owned());
                }
            }
            None
        })
        .collect();

    sections.sort();
    sections.dedup();
    sections
}

fn discover_oauth2_sections(env_map: &BTreeMap<String, String>) -> Vec<String> {
    let mut sections: Vec<String> = env_map
        .keys()
        .filter_map(|key| {
            let remainder = key.strip_prefix("MAIL_OAUTH2_")?;
            for suffix in [
                "_PROVIDER",
                "_CLIENT_ID",
                "_CLIENT_SECRET",
                "_REFRESH_TOKEN",
            ] {
                if let Some(section) = remainder.strip_suffix(suffix)
                    && !section.is_empty()
                {
                    return Some(section.to_owned());
                }
            }
            None
        })
        .collect();

    sections.sort();
    sections.dedup();
    sections
}

fn discover_smtp_sections(env_map: &BTreeMap<String, String>) -> Vec<String> {
    let mut sections: Vec<String> = env_map
        .keys()
        .filter_map(|key| {
            let remainder = key.strip_prefix("MAIL_SMTP_")?;
            for suffix in ["_HOST", "_PORT", "_USER", "_PASS", "_SECURE"] {
                if let Some(section) = remainder.strip_suffix(suffix)
                    && !section.is_empty()
                {
                    return Some(section.to_owned());
                }
            }
            None
        })
        .collect();

    sections.sort();
    sections.dedup();
    sections
}

fn redact_value(key: &str, value: Option<&str>) -> String {
    match value {
        Some(v) if is_secret_key(key) && !v.is_empty() => "<redacted>".to_owned(),
        Some("") => "<empty>".to_owned(),
        Some(v) => v.to_owned(),
        None => "<unset>".to_owned(),
    }
}

fn is_secret_key(key: &str) -> bool {
    let key = key.to_ascii_uppercase();
    key.contains("PASS") || key.contains("SECRET") || key.contains("TOKEN")
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::{
        build_help_output, discover_account_sections, is_secret_key, redact_value,
        should_check_for_updates, should_print_help,
    };

    #[test]
    fn detects_short_and_long_help_flags() {
        assert!(should_print_help(["-h"]));
        assert!(should_print_help(["--help"]));
        assert!(should_print_help(["--verbose", "-h"]));
        assert!(!should_print_help(["--verbose"]));
    }

    #[test]
    fn discovers_account_sections_from_env_like_keys() {
        let mut env_map = BTreeMap::new();
        env_map.insert(
            "MAIL_IMAP_DEFAULT_HOST".to_owned(),
            "imap.example.com".to_owned(),
        );
        env_map.insert(
            "MAIL_IMAP_WORK_USER".to_owned(),
            "work@example.com".to_owned(),
        );
        env_map.insert("MAIL_IMAP_WORK_PASS".to_owned(), "secret".to_owned());
        env_map.insert("MAIL_IMAP_WRITE_ENABLED".to_owned(), "true".to_owned());

        assert_eq!(
            discover_account_sections(&env_map),
            vec!["DEFAULT".to_owned(), "WORK".to_owned()]
        );
    }

    #[test]
    fn redacts_secret_values_and_marks_unset() {
        assert_eq!(
            redact_value("MAIL_IMAP_DEFAULT_PASS", Some("abc")),
            "<redacted>"
        );
        assert_eq!(redact_value("MAIL_IMAP_DEFAULT_HOST", Some("imap")), "imap");
        assert_eq!(redact_value("MAIL_IMAP_DEFAULT_USER", None), "<unset>");
    }

    #[test]
    fn detects_secret_keys_case_insensitively() {
        assert!(is_secret_key("mail_imap_default_pass"));
        assert!(is_secret_key("MAIL_IMAP_API_TOKEN"));
        assert!(!is_secret_key("MAIL_IMAP_DEFAULT_HOST"));
    }

    #[test]
    fn help_output_includes_policy_defaults_and_redaction() {
        let mut env_map = BTreeMap::new();
        env_map.insert(
            "MAIL_IMAP_DEFAULT_HOST".to_owned(),
            "imap.example.com".to_owned(),
        );
        env_map.insert(
            "MAIL_IMAP_DEFAULT_USER".to_owned(),
            "user@example.com".to_owned(),
        );
        env_map.insert("MAIL_IMAP_DEFAULT_PASS".to_owned(), "top-secret".to_owned());

        let help = build_help_output(&env_map);
        assert!(help.contains("Global policy defaults"));
        assert!(help.contains("MAIL_IMAP_WRITE_ENABLED=false"));
        assert!(help.contains("Send/write gate policy"));
        assert!(help.contains("MAIL_IMAP_DEFAULT_PASS=<redacted>"));
        assert!(help.contains("Admin UI environment"));
    }

    #[test]
    fn update_check_default_disabled_when_admin_on() {
        let _g = EnvLock::new("MAIL_MCP_UPDATE_CHECK", None);
        assert!(!should_check_for_updates(true));
        assert!(should_check_for_updates(false));
    }

    #[test]
    fn update_check_explicit_override() {
        let _g = EnvLock::new("MAIL_MCP_UPDATE_CHECK", Some("true"));
        assert!(should_check_for_updates(true));
    }

    /// Helper: scope an env var change for a single test.
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
