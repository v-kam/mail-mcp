###############################################################################
# Stage 1 — build the React admin UI.
#
# Outputs frontend/dist/ which is consumed by the Rust build via the
# `rust-embed` crate, baking the entire UI into the final binary.
###############################################################################
FROM node:20-alpine AS ui
WORKDIR /ui
# Copy the entire frontend/ tree in one shot. This avoids the legacy
# Docker builder's inability to glob optional files (e.g. an absent
# package-lock.json) and lets `npm install` resolve a fresh tree if
# no lock file is committed.
COPY frontend/ ./
RUN npm install --no-audit --no-fund && npm run build

###############################################################################
# Stage 2 — compile the Rust binary with the embedded UI.
#
# We use rust:1-alpine + musl-dev to produce a fully static binary that
# can run in `scratch` without glibc. SQLite ships bundled (`rusqlite`
# `bundled` feature) so no system sqlite is needed.
###############################################################################
FROM rust:1-alpine AS builder
RUN apk add --no-cache musl-dev pkgconfig perl make
WORKDIR /app
COPY . .
COPY --from=ui /ui/dist ./frontend/dist
RUN cargo build --release --bin mail-mcp

###############################################################################
# Stage 3 — minimal runtime image.
#
# /data is declared as a volume so the SQLite database survives
# container restarts. Port 8080 is exposed for the admin HTTP server;
# it stays closed unless any MAIL_MCP_ADMIN_* env var is set.
###############################################################################
FROM alpine:3.20
LABEL org.opencontainers.image.title="mail-mcp"
LABEL org.opencontainers.image.description="Email MCP server (IMAP/SMTP/Graph/EWS) with embedded admin UI"
LABEL org.opencontainers.image.source="https://github.com/tecnologicachile/mail-mcp"

RUN apk add --no-cache ca-certificates tini

COPY --from=builder /app/target/release/mail-mcp /usr/local/bin/mail-mcp

# The admin UI is opt-in: set MAIL_MCP_ADMIN_TOKEN (and ideally
# MAIL_MCP_ADMIN_KEY for write persistence) at `docker run` time to
# enable it. When enabled, the server listens on :8080 and the
# database is written to /data/mail-mcp.db.
EXPOSE 8080
VOLUME ["/data"]

# Use tini so signals (Ctrl-C, docker stop) propagate cleanly.
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/mail-mcp"]
