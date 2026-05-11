// /settings — global write/send gates and read-only timeouts.
//
// Toggling a switch posts the override to /api/settings, which the
// admin server persists in the encrypted store and (where supported)
// reflects in the live config via ArcSwap.

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { api, ApiError, type SettingsResponse } from "@/api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";

export function SettingsPage() {
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function reload() {
    try {
      const s = await api.settings();
      setSettings(s);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.body : String(e));
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function toggle(
    field: "imap_write_enabled" | "smtp_write_enabled",
    value: boolean,
  ) {
    setBusy(true);
    try {
      await api.setSettings({ [field]: value });
      await reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.body : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Toggle global write/send gates. Timeouts and other connection
          knobs are environment-driven and shown read-only.
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Request failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {!settings ? (
        <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Write gates</CardTitle>
              <CardDescription>
                MCP tools refuse mutating actions unless the matching
                gate is enabled.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-1">
              <ToggleRow
                id="imap"
                label="Allow IMAP writes"
                hint="Enables move/copy/delete/store flag operations."
                value={settings.imap_write_enabled}
                onChange={(v) => toggle("imap_write_enabled", v)}
                busy={busy}
                stored={settings.stored_overrides.imap_write_enabled}
              />
              <Separator className="my-1" />
              <ToggleRow
                id="smtp"
                label="Allow SMTP send"
                hint="Enables outbound mail through the configured SMTP."
                value={settings.smtp_write_enabled}
                onChange={(v) => toggle("smtp_write_enabled", v)}
                busy={busy}
                stored={settings.stored_overrides.smtp_write_enabled}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Connection timeouts</CardTitle>
              <CardDescription>
                Configured at startup via env vars. Restart the server to
                change them.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              <ReadRow
                label="IMAP connect"
                value={`${settings.imap_connect_timeout_ms} ms`}
              />
              <ReadRow
                label="IMAP socket"
                value={`${settings.imap_socket_timeout_ms} ms`}
              />
              <ReadRow
                label="SMTP connect"
                value={`${settings.smtp_connect_timeout_ms} ms`}
              />
              <ReadRow
                label="SMTP send"
                value={`${settings.smtp_send_timeout_ms} ms`}
              />
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

function ToggleRow({
  id,
  label,
  hint,
  value,
  onChange,
  busy,
  stored,
}: {
  id: string;
  label: string;
  hint: string;
  value: boolean;
  onChange: (next: boolean) => void;
  busy: boolean;
  stored: boolean | null;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="space-y-0.5">
        <Label htmlFor={id} className="text-sm">
          {label}
        </Label>
        <p className="text-xs text-muted-foreground">{hint}</p>
        {stored !== null && (
          <Badge variant="outline" className="mt-1 text-[10px]">
            persisted override: {String(stored)}
          </Badge>
        )}
      </div>
      <Switch
        id={id}
        checked={value}
        disabled={busy}
        onCheckedChange={onChange}
      />
    </div>
  );
}

function ReadRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-md border p-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-xs">{value}</span>
    </div>
  );
}
