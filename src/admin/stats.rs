//! Per-tool invocation analytics.
//!
//! [`ToolStatsRegistry`] is a thread-safe map of tool name → counters
//! ([`ToolStats`]). It is fed from the central
//! [`finalize_tool`](crate::server) helper in `server.rs` so every tool
//! invocation is recorded with a single line, regardless of which handler
//! produced it.
//!
//! Counters are deliberately simple (no histogram) to keep the dependency
//! footprint small. Stats are in-process only; they are reset whenever the
//! server restarts. If durable analytics are needed in the future, this is
//! the place to forward into the SQLite store or an external metrics sink.

use std::collections::HashMap;
use std::sync::RwLock;

use serde::{Deserialize, Serialize};

/// Registry of per-tool counters.
#[derive(Debug, Default)]
pub struct ToolStatsRegistry {
    inner: RwLock<HashMap<String, ToolStats>>,
}

/// Counters for a single MCP tool.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ToolStats {
    /// Total successful + failed invocations.
    pub total_calls: u64,
    /// Subset of `total_calls` that returned an error.
    pub errors: u64,
    /// Cumulative duration in ms across all calls (used to compute avg).
    pub total_duration_ms: u64,
    /// Maximum observed duration in ms.
    pub max_duration_ms: u64,
    /// Last invocation timestamp (Unix ms). 0 if never called.
    pub last_called_at: u64,
}

impl ToolStats {
    /// Average duration across all calls. Returns 0 when there are no calls.
    pub fn avg_duration_ms(&self) -> u64 {
        self.total_duration_ms
            .checked_div(self.total_calls)
            .unwrap_or(0)
    }
}

impl ToolStatsRegistry {
    /// Create a new, empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a tool invocation outcome.
    ///
    /// Called from `finalize_tool` once per request. Failures (`is_error =
    /// true`) bump both `total_calls` and `errors`.
    pub fn record(&self, tool: &str, duration_ms: u64, is_error: bool) {
        let now_ms = chrono::Utc::now().timestamp_millis().max(0) as u64;

        let mut guard = match self.inner.write() {
            Ok(g) => g,
            Err(poisoned) => {
                tracing::warn!("ToolStatsRegistry RwLock poisoned, recovering inner data");
                poisoned.into_inner()
            }
        };
        let entry = guard.entry(tool.to_owned()).or_default();
        entry.total_calls = entry.total_calls.saturating_add(1);
        if is_error {
            entry.errors = entry.errors.saturating_add(1);
        }
        entry.total_duration_ms = entry.total_duration_ms.saturating_add(duration_ms);
        if duration_ms > entry.max_duration_ms {
            entry.max_duration_ms = duration_ms;
        }
        entry.last_called_at = now_ms;
    }

    /// Snapshot all counters as `(tool_name, stats)` pairs sorted by name.
    pub fn snapshot(&self) -> Vec<(String, ToolStats)> {
        let guard = match self.inner.read() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        let mut out: Vec<(String, ToolStats)> = guard
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    /// Look up stats for a single tool, returning a zero-default if unseen.
    #[cfg(test)]
    pub fn get(&self, tool: &str) -> ToolStats {
        let guard = match self.inner.read() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        guard.get(tool).cloned().unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_increments_counters() {
        let r = ToolStatsRegistry::new();
        r.record("imap_get_message", 42, false);
        r.record("imap_get_message", 80, false);
        r.record("imap_get_message", 100, true);
        let stats = r.get("imap_get_message");
        assert_eq!(stats.total_calls, 3);
        assert_eq!(stats.errors, 1);
        assert_eq!(stats.total_duration_ms, 222);
        assert_eq!(stats.max_duration_ms, 100);
        assert_eq!(stats.avg_duration_ms(), 74);
    }

    #[test]
    fn snapshot_is_sorted() {
        let r = ToolStatsRegistry::new();
        r.record("zzz", 1, false);
        r.record("aaa", 1, false);
        let snap = r.snapshot();
        assert_eq!(snap[0].0, "aaa");
        assert_eq!(snap[1].0, "zzz");
    }
}
