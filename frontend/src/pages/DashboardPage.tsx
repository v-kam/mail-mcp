// /  — Dashboard / overview page.
//
// Three jobs:
//  1. Summarise the server (version, store mode, accounts, tools).
//  2. Hand the user a copy-pasteable MCP client config so they can wire
//     this server into Claude Desktop / Cursor / any MCP-aware client.
//     Snippets cover both transports we ship: Streamable HTTP (long-lived
//     daemon) and stdio (process-spawn).
//  3. Explain the two trust boundaries (network bearer-token vs. SQLite
//     encryption key) in plain language so the user knows what's
//     protecting what.

import { useEffect, useState } from "react";
import {
  Activity,
  Database,
  KeyRound,
  Loader2,
  Mail,
  PlusCircle,
  ServerCog,
} from "lucide-react";
import { Link } from "react-router-dom";

import {
  api,
  ApiError,
  TOKEN_KEY,
  type AccountListResponse,
  type Health,
  type ToolListResponse,
} from "@/api";
import { CopyButton } from "@/components/CopyButton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";

type Snippet = {
  id: string;
  label: string;
  intro: string;
  code: string;
  notes?: string;
};

type SnippetContext = {
  accountIds: string[];
  /** Absolute MCP HTTP URL, derived from the admin UI origin (e.g. "http://localhost:8080/mcp"). */
  httpUrl: string;
  /** True when the admin server enforces a bearer token. */
  requiresToken: boolean;
  /** Token we display in samples — actual value if logged in, otherwise placeholder. */
  tokenSample: string;
  /** True when /mcp is mounted (controlled by MAIL_MCP_HTTP_ENABLED). */
  httpEnabled: boolean;
};

function buildSnippets(ctx: SnippetContext): Snippet[] {
  const { accountIds, httpUrl, requiresToken, tokenSample, httpEnabled } = ctx;

  const httpSnippet = JSON.stringify(
    {
      mcpServers: {
        "mail-mcp": {
          url: httpUrl,
          ...(requiresToken
            ? { headers: { Authorization: `Bearer ${tokenSample}` } }
            : {}),
        },
      },
    },
    null,
    2,
  );

  const claudeRemote = JSON.stringify(
    {
      mcpServers: {
        "mail-mcp": {
          command: "npx",
          args: [
            "-y",
            "mcp-remote",
            httpUrl,
            ...(requiresToken
              ? ["--header", `Authorization:Bearer ${tokenSample}`]
              : []),
          ],
        },
      },
    },
    null,
    2,
  );

  const dockerExec = JSON.stringify(
    {
      mcpServers: {
        "mail-mcp": {
          command: "docker",
          args: [
            "exec",
            "-i",
            "-e",
            "MAIL_MCP_ADMIN_ENABLED=false",
            "mail-mcp",
            "/usr/local/bin/mail-mcp",
          ],
        },
      },
    },
    null,
    2,
  );

  const dockerRun = JSON.stringify(
    {
      mcpServers: {
        "mail-mcp": {
          command: "docker",
          args: [
            "run",
            "--rm",
            "-i",
            "-v",
            "mail-mcp-data:/data",
            "-e",
            "MAIL_MCP_DATA_DIR=/data",
            "-e",
            "MAIL_MCP_ADMIN_KEY=<your admin key>",
            "ghcr.io/tecnologicachile/mail-mcp:latest",
          ],
        },
      },
    },
    null,
    2,
  );

  const npx = JSON.stringify(
    {
      mcpServers: {
        "mail-mcp": {
          command: "npx",
          args: ["-y", "@bradsjm/mail-mcp@latest"],
          env: {
            MAIL_MCP_DATA_DIR: "/path/to/data",
            MAIL_MCP_ADMIN_KEY: "<your admin key>",
          },
        },
      },
    },
    null,
    2,
  );

  const accountHint = accountIds.length
    ? accountIds.map((a) => `\`${a}\``).join(", ")
    : "none yet — add one in /accounts.";

  const httpEntries: Snippet[] = httpEnabled
    ? [
        {
          id: "http-cursor",
          label: "HTTP — Cursor / native",
          intro:
            "Recommended for long-lived daemons. The MCP client connects to this server over HTTP/SSE — no child process, no shared filesystem. Cursor and other clients with native HTTP MCP support read this directly.",
          code: httpSnippet,
          notes: requiresToken
            ? "The token is your `MAIL_MCP_ADMIN_TOKEN`. Keep it in your client config (or a secret store) — it gates both this dashboard and the /mcp endpoint."
            : "No bearer token is configured because the server is bound to loopback. Set `MAIL_MCP_ADMIN_TOKEN` and rebind to `0.0.0.0` to allow remote AI clients.",
        },
        {
          id: "http-claude",
          label: "HTTP — Claude Desktop (mcp-remote)",
          intro:
            "Claude Desktop doesn't speak HTTP MCP natively yet. `mcp-remote` is a tiny stdio bridge that forwards JSON-RPC over your /mcp URL. Same auth, same session.",
          code: claudeRemote,
          notes: `Active account ids in the store: ${accountHint}`,
        },
      ]
    : [
        {
          id: "http-disabled",
          label: "HTTP — disabled",
          intro:
            "MCP HTTP is currently disabled (MAIL_MCP_HTTP_ENABLED=false). Either re-enable it or use one of the stdio snippets below.",
          code: "// MCP HTTP is disabled. Set MAIL_MCP_HTTP_ENABLED=true and restart.",
        },
      ];

  return [
    ...httpEntries,
    {
      id: "docker-exec",
      label: "stdio — Docker (this container)",
      intro:
        "Use stdio when you want the AI client to spawn a child process inside the running container. Same encrypted SQLite store, no extra port.",
      code: dockerExec,
      notes: `Replace "mail-mcp" with your container name if different. \`MAIL_MCP_ADMIN_ENABLED=false\` prevents the spawned process from binding the admin port a second time.`,
    },
    {
      id: "docker-run",
      label: "stdio — Docker (fresh)",
      intro:
        "One-shot: the MCP client launches a new container per session. Use the same /data volume the admin UI is using so accounts are shared.",
      code: dockerRun,
    },
    {
      id: "npx",
      label: "stdio — npx (host)",
      intro:
        "Run the published npm package directly on the host. Point MAIL_MCP_DATA_DIR at the same SQLite directory the admin uses, and pass the same MAIL_MCP_ADMIN_KEY so secrets decrypt.",
      code: npx,
      notes: `Active account id from the admin store: ${accountHint}`,
    },
  ];
}

export function DashboardPage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [accounts, setAccounts] = useState<AccountListResponse | null>(null);
  const [tools, setTools] = useState<ToolListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    async function load() {
      try {
        const [h, a, t] = await Promise.all([
          api.health(),
          api.accounts(),
          api.tools(),
        ]);
        if (!live) return;
        setHealth(h);
        setAccounts(a);
        setTools(t);
      } catch (e) {
        if (!live) return;
        setError(e instanceof ApiError ? e.body : String(e));
      }
    }
    void load();
    return () => {
      live = false;
    };
  }, []);

  const httpUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}${health?.mcp_http_path ?? "/mcp"}`
      : "http://localhost:8080/mcp";
  const sessionToken =
    typeof window !== "undefined"
      ? sessionStorage.getItem(TOKEN_KEY) || ""
      : "";

  const snippets = buildSnippets({
    accountIds: accounts?.accounts.map((a) => a.account_id) ?? [],
    httpUrl,
    requiresToken: !!health?.admin_token_required,
    tokenSample: sessionToken || "<your admin token>",
    httpEnabled: health?.mcp_http_enabled ?? true,
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Summary of the running server and how to plug it into your AI
            client.
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline" size="sm">
            <Link to="/setup">Setup notes</Link>
          </Button>
          <Button asChild size="sm">
            <Link to="/accounts">
              <PlusCircle />
              Manage accounts
            </Link>
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Could not load dashboard</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {!health || !accounts || !tools ? (
        <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <SummaryStat
              icon={<ServerCog className="h-4 w-4" />}
              label="Server"
              value={health.status}
              hint={`v${health.version}`}
            />
            <SummaryStat
              icon={<Mail className="h-4 w-4" />}
              label="MCP transport"
              value={
                health.mcp_http_enabled ? "stdio + http" : "stdio only"
              }
              hint={
                health.mcp_http_enabled
                  ? httpUrl
                  : "MAIL_MCP_HTTP_ENABLED=false"
              }
            />
            <SummaryStat
              icon={<Database className="h-4 w-4" />}
              label="Persistence"
              value={health.store_writable ? "encrypted" : "read-only"}
              hint={
                health.store_writable
                  ? "MAIL_MCP_ADMIN_KEY set"
                  : "MAIL_MCP_ADMIN_KEY missing"
              }
            />
            <SummaryStat
              icon={<Activity className="h-4 w-4" />}
              label="Accounts / tools"
              value={`${accounts.accounts.length} / ${tools.tools.length}`}
              hint={
                accounts.accounts.length
                  ? accounts.accounts.map((a) => a.account_id).join(", ")
                  : "none yet"
              }
            />
          </div>

          <ConnectCard
            snippets={snippets}
            httpEnabled={health.mcp_http_enabled}
            httpUrl={httpUrl}
          />

          <AuthExplainerCard
            adminTokenRequired={health.admin_token_required}
            storeWritable={health.store_writable}
            httpEnabled={health.mcp_http_enabled}
          />

          <AccountsAtAGlance
            accounts={accounts.accounts.map((a) => ({
              id: a.account_id,
              user: a.user ?? a.display_name ?? "—",
              imap: !!a.capabilities.imap,
              smtp: !!a.capabilities.smtp,
              graph: !!a.capabilities.graph,
              ews: !!a.capabilities.ews,
              status: a.last_verify_status,
            }))}
          />
        </>
      )}
    </div>
  );
}

function SummaryStat({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription className="flex items-center gap-2">
          {icon} {label}
        </CardDescription>
        <CardTitle className="text-lg capitalize">{value}</CardTitle>
      </CardHeader>
      <CardContent className="text-xs text-muted-foreground truncate">
        {hint}
      </CardContent>
    </Card>
  );
}

function ConnectCard({
  snippets,
  httpEnabled,
  httpUrl,
}: {
  snippets: Snippet[];
  httpEnabled: boolean;
  httpUrl: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mail className="h-4 w-4" />
          Connect your AI client
        </CardTitle>
        <CardDescription>
          Paste one of these snippets into your MCP client config (Claude
          Desktop's <code>claude_desktop_config.json</code>, Cursor's{" "}
          <code>~/.cursor/mcp.json</code>, or any other MCP-compatible
          client).{" "}
          {httpEnabled ? (
            <>
              The HTTP endpoint{" "}
              <code className="rounded bg-muted px-1 py-0.5">{httpUrl}</code>{" "}
              is recommended for long-running setups; stdio works for
              one-shot launchers.
            </>
          ) : (
            <>
              MCP HTTP is currently disabled — only stdio variants are
              available.
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue={snippets[0]!.id}>
          <TabsList>
            {snippets.map((s) => (
              <TabsTrigger key={s.id} value={s.id}>
                {s.label}
              </TabsTrigger>
            ))}
          </TabsList>
          {snippets.map((s) => (
            <TabsContent key={s.id} value={s.id} className="space-y-3">
              <p className="text-sm text-muted-foreground">{s.intro}</p>
              <div className="relative">
                <pre className="overflow-x-auto rounded-md border bg-muted/50 p-4 text-xs leading-relaxed">
                  <code>{s.code}</code>
                </pre>
                <div className="absolute right-2 top-2">
                  <CopyButton value={s.code} label="Copy JSON" />
                </div>
              </div>
              {s.notes && (
                <p className="text-xs text-muted-foreground">{s.notes}</p>
              )}
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
    </Card>
  );
}

function AuthExplainerCard({
  adminTokenRequired,
  storeWritable,
  httpEnabled,
}: {
  adminTokenRequired: boolean;
  storeWritable: boolean;
  httpEnabled: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="h-4 w-4" />
          Authentication, in plain English
        </CardTitle>
        <CardDescription>
          mail-mcp has two completely separate boundaries. They use
          different secrets and protect different things.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <AuthBlock
          title="1. Network boundary — HTTP bearer token"
          subtitle={
            adminTokenRequired
              ? "Bearer token enforced"
              : "Loopback bind — no token"
          }
          variant={adminTokenRequired ? "default" : "warning"}
        >
          <p>
            Everything we expose over HTTP on port <code>8080</code> — the
            admin UI, the <code>/api/*</code> REST endpoints, and{" "}
            {httpEnabled ? (
              <>
                the MCP transport at <code>/mcp</code>
              </>
            ) : (
              <>(MCP HTTP is currently disabled)</>
            )}{" "}
            — is gated by the same{" "}
            <strong>bearer token</strong>:{" "}
            <code>MAIL_MCP_ADMIN_TOKEN</code>. Clients send it as{" "}
            <code>Authorization: Bearer &lt;token&gt;</code>, and the
            server compares it in constant time.
          </p>
          <ul className="list-disc pl-5 space-y-1 text-sm">
            <li>
              <strong>One token, one boundary.</strong> Logging into the
              admin UI in your browser uses the same token your AI client
              would use to call <code>/mcp</code>.
            </li>
            <li>
              Binding to a non-loopback address (e.g.{" "}
              <code>0.0.0.0</code>) makes the token{" "}
              <strong>mandatory</strong> — the process refuses to start
              without one.
            </li>
            <li>
              On <code>127.0.0.1</code> without a token, the login screen
              is skipped and <code>/mcp</code> is open to anyone on that
              host.
            </li>
            <li>
              Current state:{" "}
              {adminTokenRequired ? (
                <Badge variant="success">token enforced</Badge>
              ) : (
                <Badge variant="warning">no token</Badge>
              )}
              {httpEnabled ? (
                <Badge variant="success" className="ml-1">
                  /mcp on
                </Badge>
              ) : (
                <Badge variant="outline" className="ml-1">
                  /mcp off
                </Badge>
              )}
            </li>
          </ul>
        </AuthBlock>

        <Separator />

        <AuthBlock
          title="2. Storage boundary — SQLite encryption key"
          subtitle={
            storeWritable
              ? "Encrypted store, writes enabled"
              : "No key — store is read-only"
          }
          variant={storeWritable ? "default" : "warning"}
        >
          <p>
            Mail account credentials (passwords, OAuth refresh tokens) are
            encrypted at rest in the SQLite store using a key derived from{" "}
            <code>MAIL_MCP_ADMIN_KEY</code> (Argon2id →
            ChaCha20-Poly1305). Anyone with the database file but
            <em> without</em> the key sees only ciphertext.
          </p>
          <ul className="list-disc pl-5 space-y-1 text-sm">
            <li>
              The stdio MCP launcher needs the same key in its
              environment to decrypt accounts. Without it the store opens
              read-only and tools that need real credentials will fail
              gracefully.
              Status:{" "}
              {storeWritable ? (
                <Badge variant="success">key set</Badge>
              ) : (
                <Badge variant="warning">key missing</Badge>
              )}
            </li>
            <li>
              Stdio has <em>no network</em> bearer token. Whoever can{" "}
              <code>docker exec</code> the binary can call every MCP tool
              — mind your container/host access.
            </li>
            <li>
              The IMAP write and SMTP send gates (
              <Link to="/settings" className="underline">
                Settings
              </Link>
              ) are a third layer. Even with credentials, the MCP tools
              cannot write or send mail unless the gates are explicitly
              flipped.
            </li>
          </ul>
        </AuthBlock>
      </CardContent>
    </Card>
  );
}

function AuthBlock({
  title,
  subtitle,
  variant,
  children,
}: {
  title: string;
  subtitle: string;
  variant: "default" | "warning";
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="font-medium">{title}</div>
        {variant === "warning" ? (
          <Badge variant="warning">{subtitle}</Badge>
        ) : (
          <Badge variant="secondary">{subtitle}</Badge>
        )}
      </div>
      <div className="space-y-2 text-sm text-muted-foreground">{children}</div>
    </div>
  );
}

function AccountsAtAGlance({
  accounts,
}: {
  accounts: {
    id: string;
    user: string;
    imap: boolean;
    smtp: boolean;
    graph: boolean;
    ews: boolean;
    status: string | null;
  }[];
}) {
  if (accounts.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Accounts</CardTitle>
          <CardDescription>
            You haven't added a mailbox yet. Use the wizard on the
            Accounts page — host/port/auth defaults are filled per
            provider.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild>
            <Link to="/accounts">
              <PlusCircle />
              Add your first account
            </Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Accounts</CardTitle>
        <CardDescription>
          Quick overview. Manage them on the{" "}
          <Link to="/accounts" className="underline">
            Accounts
          </Link>{" "}
          page.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2 sm:grid-cols-2">
        {accounts.map((a) => (
          <div
            key={a.id}
            className="flex items-center justify-between gap-2 rounded-md border p-3"
          >
            <div className="min-w-0">
              <div className="font-mono text-xs">{a.id}</div>
              <div className="truncate text-xs text-muted-foreground">
                {a.user}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {a.imap && <Badge variant="secondary">IMAP</Badge>}
              {a.smtp && <Badge variant="secondary">SMTP</Badge>}
              {a.graph && <Badge variant="secondary">Graph</Badge>}
              {a.ews && <Badge variant="secondary">EWS</Badge>}
              {a.status === "ok" ? (
                <Badge variant="success">ok</Badge>
              ) : a.status ? (
                <Badge variant="destructive">{a.status}</Badge>
              ) : (
                <Badge variant="outline">unverified</Badge>
              )}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
