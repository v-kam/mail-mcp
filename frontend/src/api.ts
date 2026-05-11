// Thin client around the Rust admin REST API.
//
// All requests carry an `Authorization: Bearer <token>` header sourced
// from sessionStorage. When the server reports `admin_token_required:
// false` (e.g. running on localhost without a token), no header is sent
// and the login screen is bypassed.

export const TOKEN_KEY = "mail-mcp-admin-token";

export type Capabilities = {
  imap: boolean;
  smtp: boolean;
  graph: boolean;
  ews: boolean;
};

export type ImapView = {
  host: string;
  port: number;
  user: string;
  secure: boolean;
  auth: "password" | "oauth2";
};

export type SmtpView = {
  host: string;
  port: number;
  user: string;
  security: string;
  auth: "password" | "oauth2";
};

export type OAuthView = {
  provider: string;
  client_id: string;
  has_refresh_token: boolean;
};

export type EwsView = {
  user: string;
  has_refresh_token: boolean;
};

export type AccountSummary = {
  account_id: string;
  display_name: string | null;
  user: string | null;
  capabilities: Capabilities;
  last_verify_status: string | null;
  last_verify_error: string | null;
  last_verify_at_ms: number | null;
  imap?: ImapView;
  smtp?: SmtpView;
  oauth2?: OAuthView;
  graph?: OAuthView;
  ews?: EwsView;
};

export type AccountListResponse = {
  accounts: AccountSummary[];
  store_writable: boolean;
};

export type Health = {
  status: string;
  version: string;
  store_writable: boolean;
  admin_token_required: boolean;
  /**
   * Whether the MCP Streamable HTTP transport (`POST /mcp`) is mounted.
   * Defaults to true; toggled by `MAIL_MCP_HTTP_ENABLED=false`.
   */
  mcp_http_enabled: boolean;
  /** Path served by the MCP HTTP transport (always `/mcp` today). */
  mcp_http_path: string;
};

export type SettingsResponse = {
  imap_write_enabled: boolean;
  smtp_write_enabled: boolean;
  smtp_save_sent: boolean;
  imap_connect_timeout_ms: number;
  imap_socket_timeout_ms: number;
  smtp_connect_timeout_ms: number;
  smtp_send_timeout_ms: number;
  stored_overrides: {
    imap_write_enabled: boolean | null;
    smtp_write_enabled: boolean | null;
  };
};

export type ToolEntry = { name: string; description: string };
export type ToolStat = {
  total_calls: number;
  errors: number;
  total_duration_ms: number;
  max_duration_ms: number;
  last_called_at: number;
};
export type ToolListResponse = {
  tools: ToolEntry[];
  stats: [string, ToolStat][];
};

export type AnalyticsRow = {
  name: string;
  total_calls: number;
  errors: number;
  avg_duration_ms: number;
  max_duration_ms: number;
  last_called_at: number;
};
export type AnalyticsResponse = { tools: AnalyticsRow[] };

export type ProtocolVerify = {
  protocol: string;
  ok: boolean;
  latency_ms: number;
  error: string | null;
};
export type VerifyResult = {
  account_id: string;
  overall_ok: boolean;
  protocols: ProtocolVerify[];
};

/** Persistent shape used by the editor form. Mirrors `StoredAccount`. */
export type AccountUpsert = {
  account_id: string;
  display_name?: string | null;
  imap_host?: string | null;
  imap_port?: number | null;
  imap_user?: string | null;
  imap_pass?: string | null;
  imap_secure?: boolean | null;
  smtp_host?: string | null;
  smtp_port?: number | null;
  smtp_user?: string | null;
  smtp_pass?: string | null;
  smtp_security?: string | null;
  oauth2_provider?: string | null;
  oauth2_client_id?: string | null;
  oauth2_client_secret?: string | null;
  oauth2_refresh_token?: string | null;
  graph_provider?: string | null;
  graph_client_id?: string | null;
  graph_client_secret?: string | null;
  graph_refresh_token?: string | null;
  ews_user?: string | null;
  ews_client_id?: string | null;
  ews_client_secret?: string | null;
  ews_refresh_token?: string | null;
};

/** Throwable error type with HTTP status preserved for UI handling. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public body: string,
  ) {
    super(`HTTP ${status}: ${body}`);
  }
}

function authHeader(): Record<string, string> {
  const token = sessionStorage.getItem(TOKEN_KEY);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...authHeader(),
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new ApiError(res.status, text);
  }
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

export const api = {
  health: () => request<Health>("/api/health"),
  authCheck: () => request<{ ok: boolean }>("/api/auth/check"),
  accounts: () => request<AccountListResponse>("/api/accounts"),
  account: (id: string) => request<AccountSummary>(`/api/accounts/${encodeURIComponent(id)}`),
  upsertAccount: (acc: AccountUpsert) =>
    request<{ ok: boolean; account_id: string }>("/api/accounts", {
      method: "POST",
      body: JSON.stringify(acc),
    }),
  deleteAccount: (id: string) =>
    request<{ ok: boolean; deleted: boolean }>(
      `/api/accounts/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    ),
  verify: (id: string) =>
    request<VerifyResult>(`/api/accounts/${encodeURIComponent(id)}/verify`, {
      method: "POST",
    }),
  tools: () => request<ToolListResponse>("/api/tools"),
  analytics: () => request<AnalyticsResponse>("/api/analytics"),
  settings: () => request<SettingsResponse>("/api/settings"),
  setSettings: (patch: { imap_write_enabled?: boolean; smtp_write_enabled?: boolean }) =>
    request<{ ok: boolean }>("/api/settings", {
      method: "POST",
      body: JSON.stringify(patch),
    }),
};
