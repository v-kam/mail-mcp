//! SQLite-backed account store with at-rest secret encryption.
//!
//! Holds the runtime source of truth for mail-account configuration. On
//! first start the store is empty and is seeded from `MAIL_*` environment
//! variables (when present) so the legacy stdio-only deployment keeps
//! working. After that, the database (default `/data/mail-mcp.db`) is
//! authoritative and the admin UI is the only writer.
//!
//! # Encryption at rest
//!
//! Secret fields (`imap_pass`, `smtp_pass`, `oauth2_*_secret`, `*_refresh_token`)
//! are encrypted with ChaCha20-Poly1305 (AEAD) using a 256-bit key derived
//! from [`crate::admin::AdminSettings::admin_key`] via Argon2id.
//!
//! - Salt: 16 bytes generated on first DB init, stored in the `meta` table.
//! - Per-secret nonce: 12 bytes generated at write time, stored prepended
//!   to the ciphertext.
//! - Encoding: `base64url(nonce || ciphertext || tag)`.
//!
//! When `MAIL_MCP_ADMIN_KEY` is not set, the store opens read-only:
//! existing rows can be listed (with their secrets returned as `None`) but
//! writes are rejected. This preserves zero-config dev behaviour.

use std::path::Path;
use std::sync::Mutex;

use argon2::Argon2;
use base64::Engine as _;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use rand::RngCore;
use rusqlite::{Connection, OptionalExtension, params};
use secrecy::SecretString;
use serde::{Deserialize, Serialize};

use crate::errors::{AppError, AppResult};

/// One account row as returned by the store.
///
/// Mirrors the env-variable shape so callers can rebuild a
/// [`crate::config::ServerConfig`] without provider-specific branching.
///
/// `#[serde(default)]` at the struct level lets API clients omit any
/// optional field (most commonly all the protocol blocks they don't
/// configure) without filling them in as explicit `null`s.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct StoredAccount {
    pub account_id: String,
    pub display_name: Option<String>,

    pub imap_host: Option<String>,
    pub imap_port: Option<u16>,
    pub imap_user: Option<String>,
    pub imap_pass: Option<String>,
    pub imap_secure: Option<bool>,

    pub smtp_host: Option<String>,
    pub smtp_port: Option<u16>,
    pub smtp_user: Option<String>,
    pub smtp_pass: Option<String>,
    pub smtp_security: Option<String>,

    pub oauth2_provider: Option<String>,
    pub oauth2_client_id: Option<String>,
    pub oauth2_client_secret: Option<String>,
    pub oauth2_refresh_token: Option<String>,

    pub graph_provider: Option<String>,
    pub graph_client_id: Option<String>,
    pub graph_client_secret: Option<String>,
    pub graph_refresh_token: Option<String>,

    pub ews_user: Option<String>,
    pub ews_client_id: Option<String>,
    pub ews_client_secret: Option<String>,
    pub ews_refresh_token: Option<String>,

    pub last_verify_status: Option<String>,
    pub last_verify_error: Option<String>,
    pub last_verify_at_ms: Option<i64>,

    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

/// Persistent global toggles set from the admin UI.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StoredSettings {
    pub imap_write_enabled: Option<bool>,
    pub smtp_write_enabled: Option<bool>,
}

/// Result of a verify run, persisted by [`AccountStore::set_verify_result`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerifyOutcome {
    pub status: String,
    pub error: Option<String>,
}

/// SQLite-backed store with optional secret encryption.
pub struct AccountStore {
    conn: Mutex<Connection>,
    cipher: Option<ChaCha20Poly1305>,
    /// True when the database can accept writes (i.e. an admin key is set).
    writable: bool,
}

impl AccountStore {
    /// Open or create the SQLite database at `path` and run migrations.
    ///
    /// When `admin_key` is `Some`, secret fields are encrypted with a key
    /// derived from it. When `None`, the store starts read-only.
    pub fn open(path: &Path, admin_key: Option<&str>) -> AppResult<Self> {
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent).map_err(|e| {
                AppError::Internal(format!(
                    "failed to create data dir {}: {e}",
                    parent.display()
                ))
            })?;
        }

        let conn = Connection::open(path)
            .map_err(|e| AppError::Internal(format!("sqlite open failed: {e}")))?;
        conn.pragma_update(None, "journal_mode", "WAL").ok();
        conn.pragma_update(None, "foreign_keys", "ON").ok();

        Self::migrate(&conn)?;

        let cipher = match admin_key {
            Some(key) => Some(derive_cipher(&conn, key)?),
            None => None,
        };

        Ok(Self {
            conn: Mutex::new(conn),
            writable: cipher.is_some(),
            cipher,
        })
    }

    /// Open an in-memory store for tests.
    #[cfg(test)]
    pub fn open_memory(admin_key: Option<&str>) -> AppResult<Self> {
        let conn = Connection::open_in_memory()
            .map_err(|e| AppError::Internal(format!("sqlite mem open: {e}")))?;
        Self::migrate(&conn)?;
        let cipher = match admin_key {
            Some(key) => Some(derive_cipher(&conn, key)?),
            None => None,
        };
        Ok(Self {
            conn: Mutex::new(conn),
            writable: cipher.is_some(),
            cipher,
        })
    }

    /// Whether this store can accept writes.
    pub fn writable(&self) -> bool {
        self.writable
    }

    fn migrate(conn: &Connection) -> AppResult<()> {
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS meta (
              key TEXT PRIMARY KEY,
              value BLOB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS accounts (
              account_id TEXT PRIMARY KEY,
              display_name TEXT,
              imap_host TEXT, imap_port INTEGER, imap_user TEXT, imap_pass_enc TEXT, imap_secure INTEGER,
              smtp_host TEXT, smtp_port INTEGER, smtp_user TEXT, smtp_pass_enc TEXT, smtp_security TEXT,
              oauth2_provider TEXT, oauth2_client_id TEXT, oauth2_client_secret_enc TEXT, oauth2_refresh_token_enc TEXT,
              graph_provider TEXT, graph_client_id TEXT, graph_client_secret_enc TEXT, graph_refresh_token_enc TEXT,
              ews_user TEXT, ews_client_id TEXT, ews_client_secret_enc TEXT, ews_refresh_token_enc TEXT,
              last_verify_status TEXT, last_verify_error TEXT, last_verify_at_ms INTEGER,
              created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS settings (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );
            "#,
        )
        .map_err(|e| AppError::Internal(format!("sqlite migrate: {e}")))?;
        Ok(())
    }

    fn require_writable(&self) -> AppResult<&ChaCha20Poly1305> {
        self.cipher.as_ref().ok_or_else(|| {
            AppError::InvalidInput(
                "admin store is read-only; set MAIL_MCP_ADMIN_KEY to enable writes".to_owned(),
            )
        })
    }

    fn encrypt_opt(&self, plain: Option<&str>) -> AppResult<Option<String>> {
        match plain {
            Some(s) if !s.is_empty() => {
                let cipher = self.require_writable()?;
                let mut nonce_bytes = [0u8; 12];
                rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
                let nonce = Nonce::from_slice(&nonce_bytes);
                let ct = cipher
                    .encrypt(nonce, s.as_bytes())
                    .map_err(|e| AppError::Internal(format!("encrypt failed: {e}")))?;
                let mut out = Vec::with_capacity(12 + ct.len());
                out.extend_from_slice(&nonce_bytes);
                out.extend_from_slice(&ct);
                Ok(Some(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(out)))
            }
            _ => Ok(None),
        }
    }

    fn decrypt_opt(&self, encoded: Option<String>) -> Option<String> {
        let encoded = encoded?;
        let cipher = self.cipher.as_ref()?;
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(encoded.as_bytes())
            .ok()?;
        if bytes.len() < 12 + 16 {
            return None;
        }
        let (nonce_bytes, ct) = bytes.split_at(12);
        let nonce = Nonce::from_slice(nonce_bytes);
        cipher
            .decrypt(nonce, ct)
            .ok()
            .and_then(|pt| String::from_utf8(pt).ok())
    }

    /// Return all configured accounts. When `expose_secrets` is `false`,
    /// secret fields are returned as `None` regardless of whether the store
    /// can decrypt them — used by API responses that must never leak
    /// credentials over the wire.
    pub fn list_accounts(&self, expose_secrets: bool) -> AppResult<Vec<StoredAccount>> {
        let conn = self.conn.lock().map_err(|_| {
            AppError::Internal("sqlite mutex poisoned".to_owned())
        })?;
        let mut stmt = conn
            .prepare("SELECT * FROM accounts ORDER BY account_id")
            .map_err(|e| AppError::Internal(format!("prepare list_accounts: {e}")))?;

        let rows = stmt
            .query_map([], |row| Ok(self.row_to_account(row, expose_secrets)))
            .map_err(|e| AppError::Internal(format!("query list_accounts: {e}")))?;

        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| AppError::Internal(format!("row decode: {e}")))?);
        }
        Ok(out)
    }

    /// Return a single account by id. `Ok(None)` when the row does not
    /// exist; this is **not** an error.
    pub fn get_account(
        &self,
        account_id: &str,
        expose_secrets: bool,
    ) -> AppResult<Option<StoredAccount>> {
        let conn = self.conn.lock().map_err(|_| {
            AppError::Internal("sqlite mutex poisoned".to_owned())
        })?;
        conn.query_row(
            "SELECT * FROM accounts WHERE account_id = ?1",
            params![account_id],
            |row| Ok(self.row_to_account(row, expose_secrets)),
        )
        .optional()
        .map_err(|e| AppError::Internal(format!("get_account: {e}")))
    }

    /// Insert or replace an account row. Encrypts every secret field.
    pub fn upsert_account(&self, acc: &StoredAccount) -> AppResult<()> {
        self.require_writable()?;
        let now = chrono::Utc::now().timestamp_millis();
        let conn = self.conn.lock().map_err(|_| {
            AppError::Internal("sqlite mutex poisoned".to_owned())
        })?;

        let imap_pass_enc = self.encrypt_opt(acc.imap_pass.as_deref())?;
        let smtp_pass_enc = self.encrypt_opt(acc.smtp_pass.as_deref())?;
        let oauth2_secret_enc = self.encrypt_opt(acc.oauth2_client_secret.as_deref())?;
        let oauth2_refresh_enc = self.encrypt_opt(acc.oauth2_refresh_token.as_deref())?;
        let graph_secret_enc = self.encrypt_opt(acc.graph_client_secret.as_deref())?;
        let graph_refresh_enc = self.encrypt_opt(acc.graph_refresh_token.as_deref())?;
        let ews_secret_enc = self.encrypt_opt(acc.ews_client_secret.as_deref())?;
        let ews_refresh_enc = self.encrypt_opt(acc.ews_refresh_token.as_deref())?;

        let created_at = if acc.created_at_ms > 0 {
            acc.created_at_ms
        } else {
            now
        };

        conn.execute(
            r#"
            INSERT INTO accounts (
              account_id, display_name,
              imap_host, imap_port, imap_user, imap_pass_enc, imap_secure,
              smtp_host, smtp_port, smtp_user, smtp_pass_enc, smtp_security,
              oauth2_provider, oauth2_client_id, oauth2_client_secret_enc, oauth2_refresh_token_enc,
              graph_provider, graph_client_id, graph_client_secret_enc, graph_refresh_token_enc,
              ews_user, ews_client_id, ews_client_secret_enc, ews_refresh_token_enc,
              created_at_ms, updated_at_ms
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(account_id) DO UPDATE SET
              display_name = excluded.display_name,
              imap_host = excluded.imap_host, imap_port = excluded.imap_port,
              imap_user = excluded.imap_user, imap_pass_enc = COALESCE(excluded.imap_pass_enc, accounts.imap_pass_enc),
              imap_secure = excluded.imap_secure,
              smtp_host = excluded.smtp_host, smtp_port = excluded.smtp_port,
              smtp_user = excluded.smtp_user, smtp_pass_enc = COALESCE(excluded.smtp_pass_enc, accounts.smtp_pass_enc),
              smtp_security = excluded.smtp_security,
              oauth2_provider = excluded.oauth2_provider, oauth2_client_id = excluded.oauth2_client_id,
              oauth2_client_secret_enc = COALESCE(excluded.oauth2_client_secret_enc, accounts.oauth2_client_secret_enc),
              oauth2_refresh_token_enc = COALESCE(excluded.oauth2_refresh_token_enc, accounts.oauth2_refresh_token_enc),
              graph_provider = excluded.graph_provider, graph_client_id = excluded.graph_client_id,
              graph_client_secret_enc = COALESCE(excluded.graph_client_secret_enc, accounts.graph_client_secret_enc),
              graph_refresh_token_enc = COALESCE(excluded.graph_refresh_token_enc, accounts.graph_refresh_token_enc),
              ews_user = excluded.ews_user, ews_client_id = excluded.ews_client_id,
              ews_client_secret_enc = COALESCE(excluded.ews_client_secret_enc, accounts.ews_client_secret_enc),
              ews_refresh_token_enc = COALESCE(excluded.ews_refresh_token_enc, accounts.ews_refresh_token_enc),
              updated_at_ms = excluded.updated_at_ms
            "#,
            params![
                acc.account_id,
                acc.display_name,
                acc.imap_host,
                acc.imap_port.map(i64::from),
                acc.imap_user,
                imap_pass_enc,
                acc.imap_secure.map(|b| if b { 1 } else { 0 }),
                acc.smtp_host,
                acc.smtp_port.map(i64::from),
                acc.smtp_user,
                smtp_pass_enc,
                acc.smtp_security,
                acc.oauth2_provider,
                acc.oauth2_client_id,
                oauth2_secret_enc,
                oauth2_refresh_enc,
                acc.graph_provider,
                acc.graph_client_id,
                graph_secret_enc,
                graph_refresh_enc,
                acc.ews_user,
                acc.ews_client_id,
                ews_secret_enc,
                ews_refresh_enc,
                created_at,
                now,
            ],
        )
        .map_err(|e| AppError::Internal(format!("upsert_account: {e}")))?;
        Ok(())
    }

    /// Remove an account by id. Returns `Ok(false)` if no row matched.
    pub fn delete_account(&self, account_id: &str) -> AppResult<bool> {
        self.require_writable()?;
        let conn = self.conn.lock().map_err(|_| {
            AppError::Internal("sqlite mutex poisoned".to_owned())
        })?;
        let n = conn
            .execute(
                "DELETE FROM accounts WHERE account_id = ?1",
                params![account_id],
            )
            .map_err(|e| AppError::Internal(format!("delete_account: {e}")))?;
        Ok(n > 0)
    }

    /// Persist the latest verify outcome for an account.
    pub fn set_verify_result(
        &self,
        account_id: &str,
        outcome: &VerifyOutcome,
    ) -> AppResult<()> {
        let conn = self.conn.lock().map_err(|_| {
            AppError::Internal("sqlite mutex poisoned".to_owned())
        })?;
        conn.execute(
            "UPDATE accounts SET last_verify_status = ?1, last_verify_error = ?2, last_verify_at_ms = ?3 WHERE account_id = ?4",
            params![
                outcome.status,
                outcome.error,
                chrono::Utc::now().timestamp_millis(),
                account_id
            ],
        )
        .map_err(|e| AppError::Internal(format!("set_verify_result: {e}")))?;
        Ok(())
    }

    /// Read the persistent global settings (write/send gates).
    pub fn get_settings(&self) -> AppResult<StoredSettings> {
        let conn = self.conn.lock().map_err(|_| {
            AppError::Internal("sqlite mutex poisoned".to_owned())
        })?;
        let mut s = StoredSettings::default();
        let mut stmt = conn
            .prepare("SELECT key, value FROM settings")
            .map_err(|e| AppError::Internal(format!("prepare settings: {e}")))?;
        let rows = stmt
            .query_map([], |row| {
                let k: String = row.get(0)?;
                let v: String = row.get(1)?;
                Ok((k, v))
            })
            .map_err(|e| AppError::Internal(format!("query settings: {e}")))?;
        for r in rows {
            let (k, v) = r.map_err(|e| AppError::Internal(format!("settings row: {e}")))?;
            match k.as_str() {
                "imap_write_enabled" => s.imap_write_enabled = parse_bool(&v),
                "smtp_write_enabled" => s.smtp_write_enabled = parse_bool(&v),
                _ => {}
            }
        }
        Ok(s)
    }

    /// Replace the persistent global settings.
    pub fn set_settings(&self, settings: &StoredSettings) -> AppResult<()> {
        self.require_writable()?;
        let conn = self.conn.lock().map_err(|_| {
            AppError::Internal("sqlite mutex poisoned".to_owned())
        })?;
        let tx = conn.unchecked_transaction()
            .map_err(|e| AppError::Internal(format!("settings tx: {e}")))?;
        if let Some(b) = settings.imap_write_enabled {
            tx.execute(
                "INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)",
                params!["imap_write_enabled", bool_str(b)],
            )
            .map_err(|e| AppError::Internal(format!("set settings: {e}")))?;
        }
        if let Some(b) = settings.smtp_write_enabled {
            tx.execute(
                "INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)",
                params!["smtp_write_enabled", bool_str(b)],
            )
            .map_err(|e| AppError::Internal(format!("set settings: {e}")))?;
        }
        tx.commit()
            .map_err(|e| AppError::Internal(format!("settings commit: {e}")))?;
        Ok(())
    }

    fn row_to_account(&self, row: &rusqlite::Row<'_>, expose_secrets: bool) -> StoredAccount {
        let dec = |col: &str| -> Option<String> {
            if !expose_secrets {
                return None;
            }
            let raw: Option<String> = row.get(col).ok();
            self.decrypt_opt(raw)
        };

        StoredAccount {
            account_id: row.get("account_id").unwrap_or_default(),
            display_name: row.get("display_name").ok(),
            imap_host: row.get("imap_host").ok(),
            imap_port: row
                .get::<_, Option<i64>>("imap_port")
                .ok()
                .flatten()
                .and_then(|v| u16::try_from(v).ok()),
            imap_user: row.get("imap_user").ok(),
            imap_pass: dec("imap_pass_enc"),
            imap_secure: row
                .get::<_, Option<i64>>("imap_secure")
                .ok()
                .flatten()
                .map(|v| v != 0),
            smtp_host: row.get("smtp_host").ok(),
            smtp_port: row
                .get::<_, Option<i64>>("smtp_port")
                .ok()
                .flatten()
                .and_then(|v| u16::try_from(v).ok()),
            smtp_user: row.get("smtp_user").ok(),
            smtp_pass: dec("smtp_pass_enc"),
            smtp_security: row.get("smtp_security").ok(),
            oauth2_provider: row.get("oauth2_provider").ok(),
            oauth2_client_id: row.get("oauth2_client_id").ok(),
            oauth2_client_secret: dec("oauth2_client_secret_enc"),
            oauth2_refresh_token: dec("oauth2_refresh_token_enc"),
            graph_provider: row.get("graph_provider").ok(),
            graph_client_id: row.get("graph_client_id").ok(),
            graph_client_secret: dec("graph_client_secret_enc"),
            graph_refresh_token: dec("graph_refresh_token_enc"),
            ews_user: row.get("ews_user").ok(),
            ews_client_id: row.get("ews_client_id").ok(),
            ews_client_secret: dec("ews_client_secret_enc"),
            ews_refresh_token: dec("ews_refresh_token_enc"),
            last_verify_status: row.get("last_verify_status").ok(),
            last_verify_error: row.get("last_verify_error").ok(),
            last_verify_at_ms: row.get("last_verify_at_ms").ok(),
            created_at_ms: row.get("created_at_ms").unwrap_or(0),
            updated_at_ms: row.get("updated_at_ms").unwrap_or(0),
        }
    }
}

/// Wrap the encrypted `imap_pass` into a [`SecretString`] for the runtime.
pub fn into_secret(value: Option<String>) -> Option<SecretString> {
    value
        .filter(|v| !v.is_empty())
        .map(|v| SecretString::new(v.into_boxed_str()))
}

fn bool_str(b: bool) -> &'static str {
    if b { "true" } else { "false" }
}

fn parse_bool(v: &str) -> Option<bool> {
    match v.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

/// Derive a ChaCha20-Poly1305 cipher from a user-supplied master key. The
/// salt is kept in the `meta` table so the same key always produces the
/// same data-encryption key on a given database.
fn derive_cipher(conn: &Connection, master_key: &str) -> AppResult<ChaCha20Poly1305> {
    let salt: Vec<u8> = match conn
        .query_row(
            "SELECT value FROM meta WHERE key = 'salt'",
            [],
            |r| r.get::<_, Vec<u8>>(0),
        )
        .optional()
        .map_err(|e| AppError::Internal(format!("read salt: {e}")))?
    {
        Some(s) => s,
        None => {
            let mut buf = vec![0u8; 16];
            rand::rngs::OsRng.fill_bytes(&mut buf);
            conn.execute(
                "INSERT INTO meta(key, value) VALUES('salt', ?1)",
                params![buf],
            )
            .map_err(|e| AppError::Internal(format!("write salt: {e}")))?;
            buf
        }
    };

    let argon = Argon2::default();
    let mut derived = [0u8; 32];
    argon
        .hash_password_into(master_key.as_bytes(), &salt, &mut derived)
        .map_err(|e| AppError::Internal(format!("argon2 derive: {e}")))?;
    let key = Key::from_slice(&derived);
    Ok(ChaCha20Poly1305::new(key))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_account(id: &str) -> StoredAccount {
        StoredAccount {
            account_id: id.into(),
            display_name: Some("Personal".into()),
            imap_host: Some("imap.example.com".into()),
            imap_port: Some(993),
            imap_user: Some("u@example.com".into()),
            imap_pass: Some("super-secret".into()),
            imap_secure: Some(true),
            ..Default::default()
        }
    }

    #[test]
    fn round_trip_encryption_returns_plaintext() {
        let store = AccountStore::open_memory(Some("test-key")).unwrap();
        store.upsert_account(&sample_account("default")).unwrap();
        let got = store.get_account("default", true).unwrap().unwrap();
        assert_eq!(got.imap_pass.as_deref(), Some("super-secret"));
    }

    #[test]
    fn list_accounts_redacts_when_expose_secrets_false() {
        let store = AccountStore::open_memory(Some("test-key")).unwrap();
        store.upsert_account(&sample_account("default")).unwrap();
        let accounts = store.list_accounts(false).unwrap();
        assert_eq!(accounts.len(), 1);
        assert!(accounts[0].imap_pass.is_none());
    }

    #[test]
    fn read_only_store_rejects_writes() {
        let store = AccountStore::open_memory(None).unwrap();
        assert!(!store.writable());
        assert!(store.upsert_account(&sample_account("x")).is_err());
    }

    #[test]
    fn delete_returns_false_when_missing() {
        let store = AccountStore::open_memory(Some("k")).unwrap();
        assert!(!store.delete_account("nope").unwrap());
    }
}
