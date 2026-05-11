//! Hot-swappable runtime configuration.
//!
//! Wraps [`ServerConfig`] and the three OAuth2 token managers in
//! [`ArcSwap`] cells so the admin UI can mutate configuration without
//! restarting the process. The MCP tool handlers acquire a snapshot per
//! request via [`ConfigManager::config`]; in-flight calls keep the old
//! pointer until they drop.
//!
//! Persistence and env-seeding lives here too: on first call the env
//! [`ServerConfig`] is seeded into the SQLite store, and from then on the
//! store is the source of truth.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use arc_swap::ArcSwap;
use secrecy::SecretString;

use crate::config::{AccountConfig, AuthMethod, ServerConfig};
use crate::errors::{AppError, AppResult};
use crate::ews::EwsAccountConfig;
use crate::oauth2::{OAuth2AccountConfig, OAuth2Provider, TokenManager};
use crate::smtp::{SmtpAccountConfig, SmtpSecurity};

use super::store::{AccountStore, StoredAccount};

/// Holds the current [`ServerConfig`] + token managers. Cheap to clone
/// (everything inside is `Arc`).
pub struct ConfigManager {
    config: ArcSwap<ServerConfig>,
    imap_smtp_tm: ArcSwap<Option<TokenManager>>,
    graph_tm: ArcSwap<Option<TokenManager>>,
    ews_tm: ArcSwap<Option<TokenManager>>,
    /// Globals that are seeded from env and never overridden by store rows.
    /// Keep them so we can rebuild ServerConfig on each reload.
    base_settings: ServerConfig,
    /// Optional persistent store. When `None`, the manager is env-only.
    store: Option<Arc<AccountStore>>,
}

impl ConfigManager {
    /// Create a manager with the given env-derived [`ServerConfig`] and an
    /// optional persistence layer.
    ///
    /// When `store` is provided, the env config is merged with rows from
    /// the database (DB rows override env when account ids collide). On
    /// the very first start with an empty DB, the env config is seeded
    /// into the store.
    pub fn new(env_config: ServerConfig, store: Option<Arc<AccountStore>>) -> AppResult<Self> {
        let initial = match &store {
            Some(s) if s.writable() => Self::seed_then_load(&env_config, s)?,
            Some(s) => Self::merge_env_with_store(&env_config, s)?,
            None => env_config.clone(),
        };

        let imap_smtp_tm = build_token_manager(&initial.oauth2_accounts);
        let graph_tm = build_token_manager(&initial.graph_oauth2_accounts);
        let ews_tm = build_token_manager(&initial.ews_oauth2_accounts);

        Ok(Self {
            config: ArcSwap::from(Arc::new(initial)),
            imap_smtp_tm: ArcSwap::from(Arc::new(imap_smtp_tm)),
            graph_tm: ArcSwap::from(Arc::new(graph_tm)),
            ews_tm: ArcSwap::from(Arc::new(ews_tm)),
            base_settings: env_config,
            store,
        })
    }

    /// Snapshot the current config. Returns an `Arc` so callers can hold
    /// it across `await`s without locking.
    pub fn config(&self) -> Arc<ServerConfig> {
        self.config.load_full()
    }

    /// Snapshot the current IMAP/SMTP token manager.
    pub fn imap_smtp_token_manager(&self) -> Arc<Option<TokenManager>> {
        self.imap_smtp_tm.load_full()
    }

    /// Snapshot the current Graph token manager.
    pub fn graph_token_manager(&self) -> Arc<Option<TokenManager>> {
        self.graph_tm.load_full()
    }

    /// Snapshot the current EWS token manager.
    pub fn ews_token_manager(&self) -> Arc<Option<TokenManager>> {
        self.ews_tm.load_full()
    }

    /// Reference to the persistent store, if any.
    pub fn store(&self) -> Option<&Arc<AccountStore>> {
        self.store.as_ref()
    }

    /// Rebuild the runtime config from the SQLite store and atomically
    /// swap it in. Token managers are rebuilt too. Called by the admin
    /// API after every account create/update/delete.
    pub fn reload(&self) -> AppResult<()> {
        let store = self
            .store
            .as_ref()
            .ok_or_else(|| AppError::Internal("no store configured for reload".to_owned()))?;
        let next = Self::merge_env_with_store(&self.base_settings, store)?;

        let imap_smtp_tm = build_token_manager(&next.oauth2_accounts);
        let graph_tm = build_token_manager(&next.graph_oauth2_accounts);
        let ews_tm = build_token_manager(&next.ews_oauth2_accounts);

        self.imap_smtp_tm.store(Arc::new(imap_smtp_tm));
        self.graph_tm.store(Arc::new(graph_tm));
        self.ews_tm.store(Arc::new(ews_tm));
        self.config.store(Arc::new(next));
        Ok(())
    }

    fn seed_then_load(env_config: &ServerConfig, store: &AccountStore) -> AppResult<ServerConfig> {
        // Seed only if the DB is empty (no accounts AND no settings overrides).
        let existing = store.list_accounts(false)?;
        if existing.is_empty() {
            for stored in env_to_stored_accounts(env_config) {
                store.upsert_account(&stored)?;
            }
        }
        Self::merge_env_with_store(env_config, store)
    }

    fn merge_env_with_store(
        env_config: &ServerConfig,
        store: &AccountStore,
    ) -> AppResult<ServerConfig> {
        // When the store is writable, secrets are read in plaintext and
        // used directly. When not writable, fall back to env-only config.
        let stored = store.list_accounts(store.writable())?;
        if stored.is_empty() {
            return Ok(env_config.clone());
        }

        let mut accounts: BTreeMap<String, AccountConfig> = BTreeMap::new();
        let mut oauth2: HashMap<String, OAuth2AccountConfig> = HashMap::new();
        let mut graph: HashMap<String, OAuth2AccountConfig> = HashMap::new();
        let mut ews: HashMap<String, EwsAccountConfig> = HashMap::new();
        let mut ews_oauth: HashMap<String, OAuth2AccountConfig> = HashMap::new();
        let mut smtp: HashMap<String, SmtpAccountConfig> = HashMap::new();

        for s in stored {
            let id = s.account_id.clone();

            // OAuth2 (IMAP/SMTP)
            if let (Some(provider), Some(client_id), Some(refresh)) = (
                s.oauth2_provider.as_deref(),
                s.oauth2_client_id.as_deref(),
                s.oauth2_refresh_token.as_deref(),
            ) && let Ok(p) = OAuth2Provider::parse(provider)
            {
                oauth2.insert(
                    id.clone(),
                    OAuth2AccountConfig {
                        provider: p,
                        client_id: client_id.to_owned(),
                        client_secret: SecretString::new(
                            s.oauth2_client_secret
                                .clone()
                                .unwrap_or_else(|| "none".to_owned())
                                .into_boxed_str(),
                        ),
                        refresh_token: SecretString::new(refresh.to_owned().into_boxed_str()),
                    },
                );
            }

            // Graph
            if let (Some(provider), Some(client_id), Some(refresh)) = (
                s.graph_provider.as_deref(),
                s.graph_client_id.as_deref(),
                s.graph_refresh_token.as_deref(),
            ) && let Ok(p) = OAuth2Provider::parse(provider)
            {
                graph.insert(
                    id.clone(),
                    OAuth2AccountConfig {
                        provider: p,
                        client_id: client_id.to_owned(),
                        client_secret: SecretString::new(
                            s.graph_client_secret
                                .clone()
                                .unwrap_or_else(|| "none".to_owned())
                                .into_boxed_str(),
                        ),
                        refresh_token: SecretString::new(refresh.to_owned().into_boxed_str()),
                    },
                );
            }

            // EWS
            if let Some(user) = s.ews_user.as_deref() {
                ews.insert(id.clone(), EwsAccountConfig { user: user.to_owned() });
                if let Some(refresh) = s.ews_refresh_token.as_deref() {
                    let client_id = s
                        .ews_client_id
                        .clone()
                        .unwrap_or_else(|| "d3590ed6-52b3-4102-aeff-aad2292ab01c".to_owned());
                    let client_secret = s
                        .ews_client_secret
                        .clone()
                        .unwrap_or_else(|| "none".to_owned());
                    ews_oauth.insert(
                        id.clone(),
                        OAuth2AccountConfig {
                            provider: OAuth2Provider::Microsoft,
                            client_id,
                            client_secret: SecretString::new(client_secret.into_boxed_str()),
                            refresh_token: SecretString::new(refresh.to_owned().into_boxed_str()),
                        },
                    );
                }
            }

            // IMAP — only register the runtime account when we have a usable
            // credential. An incomplete IMAP block must not abort the loop;
            // SMTP/Graph/EWS for the same account_id may still be valid.
            if let (Some(host), Some(user)) = (s.imap_host.as_deref(), s.imap_user.as_deref()) {
                let pass = super::store::into_secret(s.imap_pass.clone());
                let auth_method = if pass.is_some() {
                    Some(AuthMethod::Password)
                } else if oauth2.contains_key(&id) {
                    Some(AuthMethod::OAuth2)
                } else {
                    tracing::warn!(
                        account_id = %id,
                        "IMAP not registered for account: no password and no OAuth2 refresh token"
                    );
                    None
                };

                if let Some(auth_method) = auth_method {
                    accounts.insert(
                        id.clone(),
                        AccountConfig {
                            account_id: id.clone(),
                            host: host.to_owned(),
                            port: s.imap_port.unwrap_or(993),
                            secure: s.imap_secure.unwrap_or(true),
                            user: user.to_owned(),
                            pass,
                            auth_method,
                        },
                    );
                }
            }

            // SMTP
            if let (Some(host), Some(user)) = (s.smtp_host.as_deref(), s.smtp_user.as_deref()) {
                let pass = super::store::into_secret(s.smtp_pass.clone());
                let security = s
                    .smtp_security
                    .as_deref()
                    .map(SmtpSecurity::parse)
                    .transpose()
                    .unwrap_or(None)
                    .unwrap_or(SmtpSecurity::Starttls);
                let auth_method = if oauth2.contains_key(&id) {
                    AuthMethod::OAuth2
                } else {
                    AuthMethod::Password
                };
                smtp.insert(
                    id.clone(),
                    SmtpAccountConfig {
                        account_id: id.clone(),
                        host: host.to_owned(),
                        port: s.smtp_port.unwrap_or(587),
                        user: user.to_owned(),
                        pass,
                        security,
                        auth_method,
                    },
                );
            }
        }

        // Merge persistent settings (write/send gates).
        let stored_settings = store.get_settings().unwrap_or_default();

        let mut merged = env_config.clone();
        merged.accounts = accounts;
        merged.oauth2_accounts = oauth2;
        merged.graph_oauth2_accounts = graph;
        merged.ews_accounts = ews;
        merged.ews_oauth2_accounts = ews_oauth;
        merged.smtp_accounts = smtp;
        if let Some(b) = stored_settings.imap_write_enabled {
            merged.write_enabled = b;
        }
        if let Some(b) = stored_settings.smtp_write_enabled {
            merged.smtp_write_enabled = b;
        }
        Ok(merged)
    }
}

fn build_token_manager(
    accounts: &HashMap<String, OAuth2AccountConfig>,
) -> Option<TokenManager> {
    if accounts.is_empty() {
        None
    } else {
        Some(TokenManager::new(accounts.clone()))
    }
}

/// Convert env-derived [`ServerConfig`] account state into store rows.
///
/// Used once at first boot to seed the database; afterwards the store is
/// the source of truth.
fn env_to_stored_accounts(cfg: &ServerConfig) -> Vec<StoredAccount> {
    use secrecy::ExposeSecret;
    let mut by_id: BTreeMap<String, StoredAccount> = BTreeMap::new();

    for (id, acc) in &cfg.accounts {
        let entry = by_id.entry(id.clone()).or_insert_with(|| empty_stored(id));
        entry.imap_host = Some(acc.host.clone());
        entry.imap_port = Some(acc.port);
        entry.imap_user = Some(acc.user.clone());
        entry.imap_pass = acc.pass.as_ref().map(|s| s.expose_secret().to_owned());
        entry.imap_secure = Some(acc.secure);
    }
    for (id, acc) in &cfg.smtp_accounts {
        let entry = by_id.entry(id.clone()).or_insert_with(|| empty_stored(id));
        entry.smtp_host = Some(acc.host.clone());
        entry.smtp_port = Some(acc.port);
        entry.smtp_user = Some(acc.user.clone());
        entry.smtp_pass = acc.pass.as_ref().map(|s| s.expose_secret().to_owned());
        entry.smtp_security = Some(format!("{:?}", acc.security).to_ascii_lowercase());
    }
    for (id, oa) in &cfg.oauth2_accounts {
        let entry = by_id.entry(id.clone()).or_insert_with(|| empty_stored(id));
        entry.oauth2_provider = Some(provider_str(oa.provider));
        entry.oauth2_client_id = Some(oa.client_id.clone());
        entry.oauth2_client_secret = Some(oa.client_secret.expose_secret().to_owned());
        entry.oauth2_refresh_token = Some(oa.refresh_token.expose_secret().to_owned());
    }
    for (id, oa) in &cfg.graph_oauth2_accounts {
        let entry = by_id.entry(id.clone()).or_insert_with(|| empty_stored(id));
        entry.graph_provider = Some(provider_str(oa.provider));
        entry.graph_client_id = Some(oa.client_id.clone());
        entry.graph_client_secret = Some(oa.client_secret.expose_secret().to_owned());
        entry.graph_refresh_token = Some(oa.refresh_token.expose_secret().to_owned());
    }
    for (id, ews) in &cfg.ews_accounts {
        let entry = by_id.entry(id.clone()).or_insert_with(|| empty_stored(id));
        entry.ews_user = Some(ews.user.clone());
        if let Some(oa) = cfg.ews_oauth2_accounts.get(id) {
            entry.ews_client_id = Some(oa.client_id.clone());
            entry.ews_client_secret = Some(oa.client_secret.expose_secret().to_owned());
            entry.ews_refresh_token = Some(oa.refresh_token.expose_secret().to_owned());
        }
    }
    by_id.into_values().collect()
}

fn empty_stored(id: &str) -> StoredAccount {
    StoredAccount {
        account_id: id.to_owned(),
        ..Default::default()
    }
}

fn provider_str(p: OAuth2Provider) -> String {
    match p {
        OAuth2Provider::Google => "google".into(),
        OAuth2Provider::Microsoft => "microsoft".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_env_config() -> ServerConfig {
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

    /// Regression: a stored account with SMTP fully configured but only a
    /// half-filled IMAP block (host + user but no password / OAuth2 refresh
    /// token) used to abort the loop with `continue;`, dropping the SMTP
    /// account from the resulting [`ServerConfig`]. The user-visible symptom
    /// was `capabilities.smtp` flipping from `true` to `false` after editing
    /// an account through the admin UI.
    #[test]
    fn build_config_keeps_smtp_when_imap_block_is_incomplete() {
        let store = AccountStore::open_memory(Some("test-key")).unwrap();
        store
            .upsert_account(&StoredAccount {
                account_id: "edit-me".into(),
                imap_host: Some("imap.gmail.com".into()),
                imap_port: Some(993),
                imap_user: Some("u@example.com".into()),
                // No imap_pass and no oauth2_refresh_token: IMAP is incomplete.
                smtp_host: Some("smtp.gmail.com".into()),
                smtp_port: Some(587),
                smtp_user: Some("u@example.com".into()),
                smtp_pass: Some("real-app-password".into()),
                smtp_security: Some("starttls".into()),
                ..Default::default()
            })
            .unwrap();

        let manager =
            ConfigManager::new(empty_env_config(), Some(Arc::new(store))).unwrap();
        let cfg = manager.config();

        assert!(
            !cfg.accounts.contains_key("edit-me"),
            "IMAP must be skipped when no credential is provided",
        );
        assert!(
            cfg.smtp_accounts.contains_key("edit-me"),
            "SMTP must survive an incomplete IMAP block",
        );
    }
}
