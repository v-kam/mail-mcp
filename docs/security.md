# Security Considerations

This document outlines security features and considerations for the `mail-mcp` MCP server.

## TLS Enforcement

All IMAP connections require TLS encryption by default. Insecure connections are rejected.

### Configuration

```bash
# Per-account (default: true)
MAIL_IMAP_<ACCOUNT>_SECURE=true

# Common IMAP TLS ports
MAIL_IMAP_<ACCOUNT>_PORT=993   # IMAPS (implicit TLS)
```

### Behavior

- TLS certificate verification is enforced
- Hostname verification is performed
- Connection failures occur if certificates cannot be validated
- STARTTLS is not supported; use implicit TLS (IMAPS) on port 993

## Password Secrecy

Passwords are handled with strict secrecy guarantees:

### Storage

- Passwords are stored using Rust's `SecretString` type
- Passwords are never included in log output
- Passwords are never returned in tool responses

### Environment Variables

```bash
# Password in environment (never logged)
MAIL_IMAP_DEFAULT_PASS=your-app-password
```

### Best Practices

- Use app-specific passwords instead of account passwords when available
- Never commit `.env` files to version control
- Use secure credential managers for production deployments
- Rotate credentials periodically

## Write Operation Gating

Destructive operations are disabled by default and require explicit opt-in.

### Enabling Write Operations

```bash
MAIL_IMAP_WRITE_ENABLED=true
```

### Affected Tools

When `MAIL_IMAP_WRITE_ENABLED=false`, these tools return errors:
- `imap_update_message_flags` - Add/remove flags
- `imap_copy_message` - Copy messages
- `imap_move_message` - Move messages
- `imap_delete_message` - Delete messages

### Delete Confirmation

`imap_delete_message` requires explicit confirmation regardless of write gating:

```json
{
  "account_id": "default",
  "message_id": "imap:default:INBOX:12345:42",
  "confirm": true  // Required literal true
}
```

## Output Bounding

All potentially large outputs are bounded to prevent resource exhaustion.

### Body Text

```json
{
  "body_max_chars": 2000  // Range: 100..20000, default: 2000
}
```

### HTML Output

- HTML is sanitized using `ammonia` before return
- Potentially dangerous tags and attributes are stripped
- CSS styles are removed
- JavaScript is completely removed

### Attachment Text Extraction

```json
{
  "extract_attachment_text": true,
  "attachment_text_max_chars": 10000  // Range: 100..50000, default: 10000
}
```

### Raw Message Source

```json
{
  "max_bytes": 200000  // Range: 1024..1000000, default: 200000
}
```

### Attachment Size Limits

PDF text extraction is limited to attachments ≤ 5MB. Larger attachments are skipped but do not fail the tool call.

## Input Validation

All inputs are validated before IMAP operations:

### Length Bounds

- `query`, `from`, `to`, `subject`: 1..256 characters
- `account_id`: 1..64 characters, pattern `^[A-Za-z0-9_-]+$`
- `mailbox`: 1..256 characters
- `limit`: 1..50 messages

### Content Sanitization

- Search text fields must not contain ASCII control characters
- Mailbox names must not contain ASCII control characters

### Search Result Limits

Searches matching more than 20,000 messages are rejected:

```
Error: invalid input: search matched 25000 messages; narrow filters to at most 20000 results
```

Resolution: Add tighter filters (`last_days`, `from`, `subject`, date ranges).

## Timeout Protection

All network operations have configurable timeouts:

```bash
# Connection establishment
MAIL_IMAP_CONNECT_TIMEOUT_MS=30000      # 30 seconds

# Server greeting
MAIL_IMAP_GREETING_TIMEOUT_MS=15000     # 15 seconds

# Socket operations (idle, read, write)
MAIL_IMAP_SOCKET_TIMEOUT_MS=300000     # 5 minutes
```

Timeouts prevent indefinite hanging and ensure the server remains responsive.

## Logging and Auditing

### Log Redaction

- Passwords are never logged
- Secret-like keys (`*_PASS`, `*_TOKEN`, `*_KEY`) are redacted in logs
- Message bodies and attachments are not logged

### Response Metadata

All tool responses include metadata for auditing:

```json
{
  "meta": {
    "now_utc": "2024-02-26T10:30:45.123Z",
    "duration_ms": 245
  }
}
```

## Security Best Practices

### For End Users

1. **Use app passwords**: For Gmail, Outlook, and other services, use app-specific passwords rather than account passwords
2. **Enable 2FA**: Require two-factor authentication on email accounts
3. **Review access logs**: Periodically review email account access logs for suspicious activity
4. **Restrict write access**: Keep `MAIL_IMAP_WRITE_ENABLED=false` unless needed
5. **Secure .env files**: Ensure `.env` files have restrictive permissions (`chmod 600 .env`)

### For Operators

1. **Principle of least privilege**: Run the server with minimal required permissions
2. **Network isolation**: Deploy in isolated network segments where possible
3. **Regular updates**: Keep dependencies and the server updated
4. **Audit logs**: Monitor server logs for unusual patterns or errors
5. **Rate limiting**: Consider implementing additional rate limiting at the infrastructure layer

### For Development

1. **Security review**: Changes to security-sensitive code should be reviewed
2. **Dependency auditing**: Regularly audit dependencies for vulnerabilities
3. **Test boundaries**: Test input validation and output bounding thoroughly
4. **Secret management**: Never hardcode credentials in code or tests

## Admin UI + HTTP MCP Security

When the embedded management UI is enabled (see
[admin-ui.md](admin-ui.md)) it also mounts the **MCP Streamable HTTP
transport** at `/mcp` on the same listener. The following extra
controls apply:

- **One bearer token, one boundary**: `MAIL_MCP_ADMIN_TOKEN` gates the
  admin UI, the `/api/*` REST endpoints, *and* the MCP transport at
  `/mcp`. The token is compared in constant time on every request.
- **Bind-address guard**: the process refuses to start if the admin
  port is bound to a non-loopback address without a token.
- **HTTP MCP opt-out**: set `MAIL_MCP_HTTP_ENABLED=false` to keep the
  admin UI but disable the network MCP transport. Useful when only the
  stdio launcher is required and you want a smaller attack surface.
- **AEAD-encrypted secrets at rest**: account passwords, OAuth2 client
  secrets, and refresh tokens stored in the SQLite database are
  encrypted with ChaCha20-Poly1305 using a key derived from
  `MAIL_MCP_ADMIN_KEY` via Argon2id (16-byte salt stored in the
  `meta` table on first init). Without the master key the store opens
  read-only and HTTP MCP tool calls that need credentials fail
  gracefully.
- **Secret omission keeps existing values**: API writes that omit a
  secret field do *not* clear it, preventing accidental credential
  wipes from incomplete UI submissions.
- **No secret echo over the wire**: `GET /api/accounts` always returns
  secret fields as `null`; the UI form shows `(unchanged)` placeholders
  rather than the real value.
- **Stateful sessions are in-memory only**: the rmcp `LocalSessionManager`
  drops sessions on restart. There is no on-disk session log to leak.

## Update check

The startup update check (HTTP GET to `api.github.com`) is **disabled
by default** when the admin UI is enabled — the UI surfaces version
information instead. To force-enable it set
`MAIL_MCP_UPDATE_CHECK=true`. To disable it explicitly in stdio-only
mode, set `MAIL_MCP_UPDATE_CHECK=false`.

## Known Limitations

1. **No STARTTLS support**: Only implicit TLS (IMAPS) is supported
2. **No certificate pinning**: Certificates are validated per standard PKI; custom CA chains are not supported
3. **No client authentication**: Client certificates are not supported
4. **MCP hot reload**: each new MCP session (HTTP or stdio) reads a
   fresh config snapshot from the admin store. In-flight sessions
   continue to use the snapshot they started with — reconnect your AI
   client after editing accounts to pick up the new state. (Stdio
   launches always start fresh, so this only affects long-lived HTTP
   sessions.)
5. **No TLS on the admin port**: terminate TLS at a reverse proxy
   (nginx, Caddy, Traefik) when exposing the UI beyond localhost.
