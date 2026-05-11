# Admin UI + HTTP MCP

`mail-mcp` ships with an embedded React management UI that runs on the
same HTTP port as the **MCP Streamable HTTP transport** (`/mcp`). Run
the container once and your AI client can connect over the network
without ever spawning a child process. The UI lets you:

- See a **dashboard** with the account summary, copy-pasteable MCP
  client snippets for both transports (HTTP for daemonised setups,
  stdio for spawn-on-demand), and a plain-language explanation of the
  two auth boundaries (network bearer token vs SQLite encryption key).
- Add accounts through a **3-step provider-aware wizard** (pick provider
  → fill credentials with inline help → save & verify) — IMAP/SMTP
  hosts and ports are pre-filled per provider.
- **Edit** existing accounts: the same wizard runs in edit mode, skips
  the provider-tile step, locks the account id, and treats empty
  password fields as "keep the current secret" (the API never returns
  decrypted secrets).
- Delete and verify mail accounts at runtime, with secrets encrypted at
  rest.
- Open a brief **/setup** page with the three-step pitch and a flat
  list of provider credential pages (Gmail App Passwords, iCloud
  App-Specific Passwords, Microsoft Entra app registrations, Yahoo,
  Fastmail, Zoho).
- See per-account connectivity status (IMAP / SMTP / Graph / EWS).
- Browse every MCP tool exposed by the server with live invocation
  counters (calls, errors, average and max duration, last call time).
- Toggle the IMAP write and SMTP/Graph/EWS send gates without restarting
  the container.

## UI conventions

- Styling is **Tailwind + shadcn/ui** with no hand-written CSS rules
  beyond the global token block in `frontend/src/styles.css`. Every
  visual decision is a utility class on JSX.
- Reusable shadcn primitives live in
  `frontend/src/components/ui/*` (Button, Card, Dialog, Input, Label,
  Select, Switch, Tabs, Table, Badge, Alert, Separator). Add new
  primitives there using the same `cva` + Radix pattern.
- The provider catalogue (defaults + setup links + step-by-step
  instructions) is centralised in
  [`frontend/src/lib/providers.ts`](../frontend/src/lib/providers.ts).
  Adding a new provider only requires extending that array; the wizard
  and `/setup` page pick it up automatically.

## Architecture

```
                                ┌─▶ admin React SPA (/, /api/*)
Browser ── HTTP ──▶ axum router ┤
                                └─▶ Streamable HTTP MCP (/mcp)
                                            │
                                            ▼
                                rmcp tool router ───▶ ServerConfig snapshot
                                            ▲
MCP client ── stdio ────────────────────────┘ (one-shot launchers)
                                            │
                              ConfigManager (ArcSwap)
                                            │
                                            ▼
                              SQLite store (AEAD-encrypted secrets)
```

All transports run inside the same Rust process:

- **Admin UI / API** at `/` and `/api/*` (browser-facing).
- **MCP Streamable HTTP** at `/mcp` (`POST` for client→server,
  `GET` for SSE streams, `DELETE` to terminate a session).
- **MCP stdio** as before, for clients that prefer to spawn the
  binary directly.

Each new MCP session (HTTP or stdio) creates a fresh `MailImapServer`
from a snapshot of the current [`ConfigManager`](../src/admin/config_manager.rs).
New sessions therefore see the latest config; in-flight sessions keep
their snapshot until the client reconnects. Reconnect your AI client
after editing accounts in the UI to pick up the new state.

The UI itself is built once with Vite + React + TypeScript + Tailwind
and embedded into the Rust binary via the `rust-embed` crate, so the
runtime image stays a single artifact.

## Enabling the UI

The admin UI is **off by default** to preserve the original
stdio-only deployment. Set any of the following env vars to turn it on:

| Variable | Purpose | Default |
|---|---|---|
| `MAIL_MCP_ADMIN_ENABLED` | force-enable / disable (`true`/`false`) | unset |
| `MAIL_MCP_ADMIN_PORT` | HTTP port | `8080` |
| `MAIL_MCP_ADMIN_HOST` | bind host | `127.0.0.1`, or `0.0.0.0` if a token is set |
| `MAIL_MCP_ADMIN_TOKEN` | required when host is non-loopback | unset |
| `MAIL_MCP_ADMIN_KEY` | master key for at-rest secret encryption | unset (read-only mode) |
| `MAIL_MCP_DATA_DIR` | directory holding `mail-mcp.db` | `/data` |
| `MAIL_MCP_HTTP_ENABLED` | mount the MCP Streamable HTTP transport at `/mcp` | `true` |
| `MAIL_MCP_UPDATE_CHECK` | startup phone-home to GitHub | `false` when admin is on |

### Hard guarantee

If the bind address is non-loopback (e.g. `0.0.0.0:8080`) and no token
is set, the process **refuses to start**. This is enforced in
[`AdminSettings::from_env`](../src/admin/mod.rs).

### Recommended setup (single container)

```bash
docker run -d \
  --name mail-mcp \
  -p 8080:8080 \
  -v mail-mcp-data:/data \
  -e MAIL_MCP_ADMIN_TOKEN="$(openssl rand -hex 32)" \
  -e MAIL_MCP_ADMIN_KEY="$(openssl rand -hex 32)" \
  -e MAIL_IMAP_WRITE_ENABLED=true \
  -e MAIL_SMTP_WRITE_ENABLED=true \
  ghcr.io/tecnologicachile/mail-mcp:latest
```

Then open `http://localhost:8080` and paste the token to log in.

### Localhost / dev mode

When you only run on localhost (e.g. behind a Tailscale or VPN tunnel)
and don't want to set a token:

```bash
MAIL_MCP_ADMIN_PORT=8080 \
MAIL_MCP_ADMIN_KEY=dev-key \
cargo run --release
```

The UI binds to `127.0.0.1:8080` and skips the login screen.

## Persistence and encryption

- The SQLite database lives at `<MAIL_MCP_DATA_DIR>/mail-mcp.db`.
- Secret fields (`imap_pass`, `smtp_pass`, OAuth2 client secrets and
  refresh tokens) are encrypted with **ChaCha20-Poly1305** (AEAD).
- The data-encryption key is derived from `MAIL_MCP_ADMIN_KEY` via
  **Argon2id** with a 16-byte salt generated on first DB init and
  stored in the `meta` table. Same key + same DB always produces the
  same data key.
- Without `MAIL_MCP_ADMIN_KEY` the store opens **read-only**: the UI
  shows existing accounts (with secrets redacted) and can verify them,
  but cannot persist new ones.
- On first start, when env vars define accounts and the DB is empty,
  the env config is seeded into the DB. Afterwards the DB is the
  source of truth — updating env vars no longer changes runtime
  config (use the UI instead).

## API surface

Two HTTP surfaces share the same listener and the same bearer-token
check:

| Surface | Paths | Auth |
|---|---|---|
| Admin REST | `/api/*` | `Authorization: Bearer <MAIL_MCP_ADMIN_TOKEN>` when set |
| MCP Streamable HTTP | `/mcp` (POST / GET / DELETE) | same token, same constant-time check |

### Admin REST endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | unauthenticated probe (also reports `mcp_http_enabled` and `mcp_http_path`) |
| GET | `/api/auth/check` | authenticated probe (used by the login screen) |
| GET | `/api/tools` | static catalog joined with live stats |
| GET | `/api/analytics` | per-tool counters |
| GET, POST | `/api/settings` | read / patch write & send gates |
| GET, POST | `/api/accounts` | list / create-or-update an account |
| GET, PUT, DELETE | `/api/accounts/:id` | single account CRUD |
| POST | `/api/accounts/:id/verify` | run IMAP/SMTP/Graph/EWS connectivity tests |

`POST` to `/api/accounts` accepts the same JSON shape as the
[`StoredAccount`](../src/admin/store.rs) struct. Secret fields are
write-only — the API never returns them, and a write that omits a
secret keeps the existing value (no accidental wipe).

### MCP HTTP transport (`/mcp`)

Implements the MCP **Streamable HTTP** specification (2025-03-26):

- `POST /mcp` accepts a single JSON-RPC request and returns a
  `text/event-stream` of one or more responses (the server sends `0`
  retry priming, then the response, then closes).
- `GET /mcp` opens a long-lived SSE channel for the same session
  (server→client notifications). Requires the `Mcp-Session-Id` header
  returned in the initial `POST` response.
- `DELETE /mcp` closes a session.

Every request must:
- Include `Authorization: Bearer <MAIL_MCP_ADMIN_TOKEN>` when the token
  is configured.
- Set `Accept: application/json, text/event-stream` (POST) or
  `Accept: text/event-stream` (GET).

Sessions are stateful and live in memory; restarting the container
drops them. The handler creates a fresh `MailImapServer` per session
from the current `ConfigManager` snapshot, so new sessions always pick
up edits made through the admin UI.

Disable just `/mcp` (without affecting the admin UI) by setting
`MAIL_MCP_HTTP_ENABLED=false`.

## Authentication: two boundaries, two secrets

mail-mcp has two completely separate auth boundaries. They use
different secrets and protect different things — the dashboard
surfaces this in the UI but it is worth spelling out here too.

### 1. Network boundary — `MAIL_MCP_ADMIN_TOKEN`

Everything we expose over HTTP on the admin port is gated by the same
bearer token: the admin UI, every `/api/*` REST endpoint, and the MCP
transport at `/mcp`. Clients send `Authorization: Bearer <token>` and
the server checks it with constant-time comparison.

- One token, one boundary. The same token your browser uses to log in
  is what your AI client uses to call `/mcp`.
- Binding to a non-loopback address (e.g. `0.0.0.0:8080`) makes the
  token **mandatory** — the process refuses to start without one.
- On `127.0.0.1` without a token, both the UI and `/mcp` are open to
  any local process.

### 2. Storage boundary — `MAIL_MCP_ADMIN_KEY`

Mail account credentials (passwords, OAuth refresh tokens) are
encrypted at rest in the SQLite store using a key derived from
`MAIL_MCP_ADMIN_KEY` (Argon2id → ChaCha20-Poly1305). Anyone with the
database file but **without** the key sees only ciphertext.

- The stdio MCP launcher needs the same key in its environment to
  decrypt accounts. Without it the store opens read-only and tools
  that need real credentials fail gracefully.
- The HTTP MCP transport reads the same store; the admin token alone
  is not enough to call tools that need account credentials when the
  store is read-only.

### 3. Stdio transport — process boundary

When an AI client spawns the binary directly over stdio (the classic
MCP launcher pattern), there is no bearer token because the boundary
is process-level rather than network-level. Whoever can `docker exec`
or `npx` the binary can call every MCP tool. Mind your container/host
access lists.

In short:

| Boundary | Secret | Verb |
|---|---|---|
| HTTP (UI + `/api/*` + `/mcp`) | `MAIL_MCP_ADMIN_TOKEN` | "let me see/edit accounts and call MCP tools" |
| Encrypted SQLite store | `MAIL_MCP_ADMIN_KEY` | "let me decrypt credentials" |
| stdio MCP launcher | (none — process boundary) | "let me invoke tools" |
| IMAP write / SMTP send gates | runtime toggle | "let me actually mutate or send mail" |

## Threat model

The admin UI is intentionally narrow:

- **Single shared admin token.** No multi-user, no RBAC, no audit log.
  If a single team-shared token isn't enough, put a reverse proxy
  (with SSO) in front of the UI and bind it to `127.0.0.1`.
- **No TLS termination.** Use a reverse proxy (nginx, Caddy, Traefik)
  for HTTPS when exposing the UI beyond localhost.
- **No CSRF protection.** Every mutating endpoint requires the bearer
  token in `Authorization`, so cross-site requests cannot send it
  automatically. If you load the UI from a third-party origin, supply
  the token explicitly.
- **No rate limiting.** Add it at the proxy layer if you expose the
  UI to the public internet.

## Building locally

```bash
# 1. Build the React UI
cd frontend
npm install
npm run build
cd ..

# 2. Build the Rust binary (embeds frontend/dist)
cargo build --release

# 3. Run with admin UI
MAIL_MCP_ADMIN_PORT=8080 \
MAIL_MCP_ADMIN_TOKEN=dev \
MAIL_MCP_ADMIN_KEY=dev \
MAIL_MCP_DATA_DIR=./data \
./target/release/mail-mcp
```

For development with hot-reload of the React UI:

```bash
# Terminal 1 — Rust admin server
MAIL_MCP_ADMIN_PORT=8080 \
MAIL_MCP_ADMIN_TOKEN=dev \
MAIL_MCP_ADMIN_KEY=dev \
cargo run

# Terminal 2 — Vite dev server (proxies /api to the Rust server)
cd frontend
npm run dev
# open http://localhost:5173
```
