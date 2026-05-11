// /accounts — list mailboxes, launch the wizard, and run inline verifies.
//
// The list shows compact account cards with capability badges and the
// last verify outcome. The "Add account" button opens the provider-aware
// wizard; per-row verify/delete actions use the existing API.

import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  CircleDot,
  Loader2,
  Pencil,
  PlusCircle,
  RefreshCw,
  Trash2,
  XCircle,
} from "lucide-react";

import {
  api,
  ApiError,
  type AccountSummary,
  type VerifyResult,
} from "@/api";
import { AccountWizard } from "@/components/AccountWizard";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

function relative(ms: number | null): string {
  if (!ms) return "never";
  const diff = Date.now() - ms;
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

export function AccountsPage() {
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [storeWritable, setStoreWritable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<AccountSummary | null>(null);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.accounts();
      setAccounts(r.accounts);
      setStoreWritable(r.store_writable);
    } catch (e) {
      setError(e instanceof ApiError ? e.body : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function verify(id: string) {
    setVerifying(id);
    setVerifyResult(null);
    try {
      const r = await api.verify(id);
      setVerifyResult(r);
      await reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.body : String(e));
    } finally {
      setVerifying(null);
    }
  }

  async function remove(id: string) {
    if (!confirm(`Delete account "${id}"?`)) return;
    try {
      await api.deleteAccount(id);
      await reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.body : String(e));
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Accounts</h1>
          <p className="text-sm text-muted-foreground">
            Mailboxes that the MCP server can act on. Add, edit, or verify
            here.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={reload}>
            <RefreshCw />
            Refresh
          </Button>
          <Button
            onClick={() => {
              setEditTarget(null);
              setWizardOpen(true);
            }}
            disabled={!storeWritable}
          >
            <PlusCircle />
            Add account
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Request failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {verifyResult && (
        <Alert variant={verifyResult.overall_ok ? "success" : "destructive"}>
          <AlertTitle>
            Verify “{verifyResult.account_id}”:{" "}
            {verifyResult.overall_ok ? "OK" : "failed"}
          </AlertTitle>
          <AlertDescription className="space-y-1 text-sm">
            {verifyResult.protocols.map((p) => (
              <div key={p.protocol} className="flex items-center gap-2">
                {p.ok ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                ) : (
                  <XCircle className="h-3.5 w-3.5 text-destructive" />
                )}
                <span className="font-mono text-xs">{p.protocol}</span>
                <span className="text-muted-foreground text-xs">
                  ({p.latency_ms} ms){p.error ? ` — ${p.error}` : ""}
                </span>
              </div>
            ))}
          </AlertDescription>
        </Alert>
      )}

      {loading ? (
        <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : accounts.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <CircleDot className="h-8 w-8 text-muted-foreground" />
            <div>
              <CardTitle>No accounts yet</CardTitle>
              <CardDescription className="mt-1">
                Add your first mailbox to start using the MCP tools.
              </CardDescription>
            </div>
            <Button
              onClick={() => {
                setEditTarget(null);
                setWizardOpen(true);
              }}
              disabled={!storeWritable}
            >
              <PlusCircle />
              Add account
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {accounts.map((acc) => (
            <AccountCard
              key={acc.account_id}
              account={acc}
              busy={verifying === acc.account_id}
              writable={storeWritable}
              onEdit={() => {
                setEditTarget(acc);
                setWizardOpen(true);
              }}
              onVerify={() => verify(acc.account_id)}
              onDelete={() => remove(acc.account_id)}
            />
          ))}
        </div>
      )}

      <AccountWizard
        open={wizardOpen}
        editAccount={editTarget}
        onClose={() => {
          setWizardOpen(false);
          setEditTarget(null);
        }}
        onSaved={reload}
      />
    </div>
  );
}

function AccountCard({
  account,
  busy,
  writable,
  onEdit,
  onVerify,
  onDelete,
}: {
  account: AccountSummary;
  busy: boolean;
  writable: boolean;
  onEdit: () => void;
  onVerify: () => void;
  onDelete: () => void;
}) {
  const caps = account.capabilities;
  const status = account.last_verify_status;
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="font-mono text-sm">
              {account.account_id}
            </CardTitle>
            <CardDescription className="truncate">
              {account.display_name || account.user || "—"}
            </CardDescription>
          </div>
          {status === "ok" ? (
            <Badge variant="success">verified</Badge>
          ) : status ? (
            <Badge variant="destructive">{status}</Badge>
          ) : (
            <Badge variant="outline">unverified</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex flex-wrap gap-1.5">
          {caps.imap && <Badge variant="secondary">IMAP</Badge>}
          {caps.smtp && <Badge variant="secondary">SMTP</Badge>}
          {caps.graph && <Badge variant="secondary">Graph</Badge>}
          {caps.ews && <Badge variant="secondary">EWS</Badge>}
        </div>
        <div className="text-xs text-muted-foreground">
          Last checked: {relative(account.last_verify_at_ms)}
        </div>
        {account.last_verify_error && (
          <div className="text-xs text-destructive break-words">
            {account.last_verify_error}
          </div>
        )}
      </CardContent>
      <CardFooter className="gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={onEdit}
          disabled={!writable}
        >
          <Pencil />
          Edit
        </Button>
        <Button size="sm" variant="outline" onClick={onVerify} disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          Verify
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onDelete}
          disabled={!writable}
          className="text-destructive hover:text-destructive"
        >
          <Trash2 />
        </Button>
      </CardFooter>
    </Card>
  );
}
