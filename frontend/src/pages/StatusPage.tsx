// /status — high-level health overview.
//
// Sections:
//   * Server pill (status, version, store_writable)
//   * Account capability matrix (IMAP / SMTP / Graph / EWS)
//   * Global write-gate flags

import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, MinusCircle, XCircle } from "lucide-react";

import {
  api,
  ApiError,
  type AccountSummary,
  type Health,
  type SettingsResponse,
} from "@/api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

function dot(value: boolean | undefined) {
  if (value === undefined) {
    return <MinusCircle className="h-4 w-4 text-muted-foreground" />;
  }
  return value ? (
    <CheckCircle2 className="h-4 w-4 text-success" />
  ) : (
    <XCircle className="h-4 w-4 text-destructive" />
  );
}

export function StatusPage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [h, a, s] = await Promise.all([
          api.health(),
          api.accounts(),
          api.settings(),
        ]);
        if (!live) return;
        setHealth(h);
        setAccounts(a.accounts);
        setSettings(s);
      } catch (e) {
        if (!live) return;
        setError(e instanceof ApiError ? e.body : String(e));
      } finally {
        if (live) setLoading(false);
      }
    }
    void load();
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Status</h1>
        <p className="text-sm text-muted-foreground">
          Server health, per-account capabilities, and global gates.
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Request failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {loading ? (
        <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Server</CardDescription>
                <CardTitle className="text-lg">
                  {health?.status ?? "unknown"}
                </CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                <Badge variant="outline" className="font-mono">
                  v{health?.version}
                </Badge>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Persistence</CardDescription>
                <CardTitle className="text-lg">
                  {health?.store_writable ? "Encrypted store" : "Read-only"}
                </CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                {health?.store_writable
                  ? "Account writes encrypted at rest"
                  : "Set MAIL_MCP_ADMIN_KEY to enable writes"}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Authentication</CardDescription>
                <CardTitle className="text-lg">
                  {health?.admin_token_required ? "Token required" : "Open"}
                </CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                {health?.admin_token_required
                  ? "Admin token is required for writes"
                  : "Loopback bind without a token"}
              </CardContent>
            </Card>
          </div>

          {settings && (
            <Card>
              <CardHeader>
                <CardTitle>Global gates</CardTitle>
                <CardDescription>
                  Toggle these on the Settings page. They apply to every
                  account.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3 sm:grid-cols-2">
                <GateRow
                  label="IMAP write enabled"
                  value={settings.imap_write_enabled}
                />
                <GateRow
                  label="SMTP send enabled"
                  value={settings.smtp_write_enabled}
                />
                <GateRow
                  label="SMTP save-sent"
                  value={settings.smtp_save_sent}
                />
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Account capabilities</CardTitle>
              <CardDescription>
                Capability flags reflect which protocols are configured per
                account. Use the Accounts page to verify connectivity.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {accounts.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No accounts configured yet.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Account</TableHead>
                      <TableHead>Display</TableHead>
                      <TableHead className="w-[60px] text-center">IMAP</TableHead>
                      <TableHead className="w-[60px] text-center">SMTP</TableHead>
                      <TableHead className="w-[60px] text-center">Graph</TableHead>
                      <TableHead className="w-[60px] text-center">EWS</TableHead>
                      <TableHead>Last verify</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {accounts.map((a) => (
                      <TableRow key={a.account_id}>
                        <TableCell className="font-mono text-xs">
                          {a.account_id}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {a.display_name || a.user || "—"}
                        </TableCell>
                        <TableCell className="text-center">
                          {dot(a.capabilities.imap)}
                        </TableCell>
                        <TableCell className="text-center">
                          {dot(a.capabilities.smtp)}
                        </TableCell>
                        <TableCell className="text-center">
                          {dot(a.capabilities.graph)}
                        </TableCell>
                        <TableCell className="text-center">
                          {dot(a.capabilities.ews)}
                        </TableCell>
                        <TableCell>
                          {a.last_verify_status === "ok" ? (
                            <Badge variant="success">ok</Badge>
                          ) : a.last_verify_status ? (
                            <Badge variant="destructive">
                              {a.last_verify_status}
                            </Badge>
                          ) : (
                            <Badge variant="outline">unverified</Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function GateRow({ label, value }: { label: string; value: boolean }) {
  return (
    <div className="flex items-center justify-between rounded-md border p-3 text-sm">
      <span>{label}</span>
      {value ? (
        <Badge variant="success">enabled</Badge>
      ) : (
        <Badge variant="outline">disabled</Badge>
      )}
    </div>
  );
}
