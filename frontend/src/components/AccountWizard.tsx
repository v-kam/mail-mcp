// Provider-aware 3-step account wizard.
//
// Step 1 — pick a provider tile: hosts, ports and the auth methods are
//          pre-filled from `lib/providers.ts` so the user doesn't have
//          to type imap.gmail.com from memory.
// Step 2 — enter credentials. Each protocol section carries inline
//          links to the provider's credential page (e.g. Gmail App
//          Passwords) so the user can mint the password without
//          leaving the wizard's mental model.
// Step 3 — save then run a connectivity verify and show per-protocol
//          ok/error badges.
//
// Edit mode — when `editAccount` is provided, Step 1 is skipped: we
// pre-fill the form with the existing account, lock the account_id,
// detect the provider from the IMAP host, and treat empty password
// fields as "keep the existing value" (the API never returns secrets).

import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowRight,
  CheckCircle2,
  ChevronLeft,
  ExternalLink,
  Loader2,
  Mail,
  Pencil,
  ShieldAlert,
  XCircle,
} from "lucide-react";

import {
  api,
  ApiError,
  type AccountSummary,
  type AccountUpsert,
  type VerifyResult,
} from "@/api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  PROVIDERS,
  authLabel,
  detectProviderFromImapHost,
  findProvider,
  type AuthMethod,
  type ProviderId,
} from "@/lib/providers";

interface FormState {
  account_id: string;
  display_name: string;
  imap_host: string;
  imap_port: number;
  imap_user: string;
  imap_pass: string;
  imap_secure: boolean;
  smtp_host: string;
  smtp_port: number;
  smtp_user: string;
  smtp_pass: string;
  smtp_security: "starttls" | "tls" | "plain";
  oauth2_provider: string;
  oauth2_client_id: string;
  oauth2_client_secret: string;
  oauth2_refresh_token: string;
  same_password: boolean;
  imap_pass_dirty: boolean;
  smtp_pass_dirty: boolean;
}

function emptyForm(): FormState {
  return {
    account_id: "",
    display_name: "",
    imap_host: "",
    imap_port: 993,
    imap_user: "",
    imap_pass: "",
    imap_secure: true,
    smtp_host: "",
    smtp_port: 587,
    smtp_user: "",
    smtp_pass: "",
    smtp_security: "starttls",
    oauth2_provider: "",
    oauth2_client_id: "",
    oauth2_client_secret: "",
    oauth2_refresh_token: "",
    same_password: true,
    imap_pass_dirty: false,
    smtp_pass_dirty: false,
  };
}

function applyTemplate(
  form: FormState,
  providerId: ProviderId,
  auth: AuthMethod,
): FormState {
  const t = findProvider(providerId);
  return {
    ...form,
    imap_host: t.imap?.host ?? form.imap_host,
    imap_port: t.imap?.port ?? form.imap_port,
    imap_secure: t.imap?.secure ?? form.imap_secure,
    smtp_host: t.smtp?.host ?? form.smtp_host,
    smtp_port: t.smtp?.port ?? form.smtp_port,
    smtp_security: t.smtp?.security ?? form.smtp_security,
    oauth2_provider:
      auth === "oauth2"
        ? providerId === "gmail"
          ? "google"
          : providerId === "microsoft"
            ? "microsoft"
            : ""
        : "",
  };
}

function toUpsert(form: FormState, auth: AuthMethod): AccountUpsert {
  const out: AccountUpsert = {
    account_id: form.account_id,
    display_name: form.display_name || null,
    imap_host: form.imap_host || null,
    imap_port: form.imap_port,
    imap_user: form.imap_user || null,
    imap_secure: form.imap_secure,
    smtp_host: form.smtp_host || null,
    smtp_port: form.smtp_port,
    smtp_user: form.smtp_user || form.imap_user || null,
    smtp_security: form.smtp_security,
  };
  if (form.imap_pass_dirty && form.imap_pass) {
    out.imap_pass = form.imap_pass;
    if (form.same_password) {
      out.smtp_pass = form.imap_pass;
    }
  }
  if (form.smtp_pass_dirty && form.smtp_pass && !form.same_password) {
    out.smtp_pass = form.smtp_pass;
  }
  if (auth === "oauth2") {
    out.oauth2_provider = form.oauth2_provider || null;
    out.oauth2_client_id = form.oauth2_client_id || null;
    if (form.oauth2_client_secret)
      out.oauth2_client_secret = form.oauth2_client_secret;
    if (form.oauth2_refresh_token)
      out.oauth2_refresh_token = form.oauth2_refresh_token;
  }
  return out;
}

type Step = "provider" | "credentials" | "verify";

interface Props {
  open: boolean;
  /** When set, the wizard runs in edit mode (skips the provider step). */
  editAccount?: AccountSummary | null;
  onClose: () => void;
  onSaved: () => void;
}

function formFromAccount(acc: AccountSummary): FormState {
  return {
    account_id: acc.account_id,
    display_name: acc.display_name ?? "",
    imap_host: acc.imap?.host ?? "",
    imap_port: acc.imap?.port ?? 993,
    imap_user: acc.imap?.user ?? acc.user ?? "",
    imap_pass: "",
    imap_secure: acc.imap?.secure ?? true,
    smtp_host: acc.smtp?.host ?? "",
    smtp_port: acc.smtp?.port ?? 587,
    smtp_user: acc.smtp?.user ?? "",
    smtp_pass: "",
    smtp_security:
      (acc.smtp?.security as FormState["smtp_security"]) ?? "starttls",
    oauth2_provider: acc.oauth2?.provider ?? acc.graph?.provider ?? "",
    oauth2_client_id: acc.oauth2?.client_id ?? acc.graph?.client_id ?? "",
    oauth2_client_secret: "",
    oauth2_refresh_token: "",
    same_password: false,
    imap_pass_dirty: false,
    smtp_pass_dirty: false,
  };
}

function authFromAccount(acc: AccountSummary): AuthMethod {
  if (acc.imap?.auth === "oauth2" || acc.smtp?.auth === "oauth2") return "oauth2";
  // No way to tell App-Password from Password from the redacted summary.
  // Default to App-Password since that's what 95% of provider templates
  // recommend; the user can change it inline if needed.
  return "app_password";
}

export function AccountWizard({ open, editAccount, onClose, onSaved }: Props) {
  const editing = !!editAccount;

  const [step, setStep] = useState<Step>("provider");
  const [providerId, setProviderId] = useState<ProviderId | null>(null);
  const [auth, setAuth] = useState<AuthMethod>("app_password");
  const [form, setForm] = useState<FormState>(emptyForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);

  useEffect(() => {
    if (!open) return;
    setBusy(false);
    setError(null);
    setVerifyResult(null);
    if (editAccount) {
      setProviderId(detectProviderFromImapHost(editAccount.imap?.host));
      setAuth(authFromAccount(editAccount));
      setForm(formFromAccount(editAccount));
      setStep("credentials");
    } else {
      setProviderId(null);
      setAuth("app_password");
      setForm(emptyForm());
      setStep("provider");
    }
  }, [open, editAccount]);

  const provider = providerId ? findProvider(providerId) : null;

  function pickProvider(id: ProviderId) {
    const t = findProvider(id);
    const initialAuth = t.defaultAuth;
    setProviderId(id);
    setAuth(initialAuth);
    setForm((prev) => applyTemplate(prev, id, initialAuth));
    setStep("credentials");
  }

  function changeAuth(next: AuthMethod) {
    setAuth(next);
    if (providerId) {
      setForm((prev) => applyTemplate(prev, providerId, next));
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.upsertAccount(toUpsert(form, auth));
      const result = await api.verify(form.account_id);
      setVerifyResult(result);
      setStep("verify");
      onSaved();
    } catch (e) {
      const msg =
        e instanceof ApiError ? e.body : e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  function close() {
    if (busy) return;
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {editing ? (
              <>
                <Pencil className="h-5 w-5" />
                Edit account: {editAccount?.account_id}
              </>
            ) : (
              <>
                <Mail className="h-5 w-5" />
                New mail account
              </>
            )}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? "Update credentials, host details or auth method. Leave password fields empty to keep the current secret."
              : "Connect a mailbox in three steps. Hosts, ports, and credential URLs are pre-filled per provider."}
          </DialogDescription>
        </DialogHeader>

        {!editing && <Stepper current={step} />}

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {step === "provider" && <ProviderStep onPick={pickProvider} />}
          {step === "credentials" && provider && (
            <CredentialsStep
              provider={provider}
              auth={auth}
              setAuth={changeAuth}
              form={form}
              setForm={setForm}
              error={error}
              editing={editing}
            />
          )}
          {step === "verify" && verifyResult && (
            <VerifyStep result={verifyResult} />
          )}
        </div>

        <DialogFooter>
          {step === "credentials" && !editing && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => setStep("provider")}
              disabled={busy}
            >
              <ChevronLeft />
              Back
            </Button>
          )}
          {step === "credentials" && (
            <>
              {editing && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={close}
                  disabled={busy}
                >
                  Cancel
                </Button>
              )}
              <Button
                type="button"
                onClick={save}
                disabled={!isValid(form, auth, editing) || busy}
              >
                {busy ? <Loader2 className="animate-spin" /> : <ArrowRight />}
                {busy
                  ? "Saving and verifying…"
                  : editing
                    ? "Save changes and verify"
                    : "Save and verify"}
              </Button>
            </>
          )}
          {step === "verify" && (
            <Button type="button" onClick={close}>
              Done
            </Button>
          )}
          {step === "provider" && (
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function isValid(form: FormState, auth: AuthMethod, editing: boolean): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(form.account_id)) return false;
  if (!form.imap_host || !form.imap_user) return false;
  // When editing, an empty password means "keep the current secret".
  if (
    !editing &&
    (auth === "password" || auth === "app_password") &&
    !form.imap_pass
  ) {
    return false;
  }
  if (!editing && auth === "oauth2" && !form.oauth2_refresh_token) return false;
  return true;
}

// ─── Step 1: Provider picker ────────────────────────────────────────────────

function ProviderStep({ onPick }: { onPick: (id: ProviderId) => void }) {
  return (
    <div>
      <p className="text-sm text-muted-foreground mb-4">
        Pick the provider that hosts this mailbox. We'll fill in the IMAP
        and SMTP servers automatically.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {PROVIDERS.map((p) => (
          <Card
            key={p.id}
            role="button"
            tabIndex={0}
            onClick={() => onPick(p.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") onPick(p.id);
            }}
            className="cursor-pointer hover:border-primary/60 hover:bg-card/80 transition-colors focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <CardContent className="flex items-center gap-3 p-4">
              <div
                className={cn(
                  "flex h-10 w-10 items-center justify-center rounded-md font-semibold",
                  p.badgeClass,
                )}
              >
                {p.initial}
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-medium leading-tight">{p.name}</div>
                <div className="text-xs text-muted-foreground truncate">
                  {p.tagline}
                </div>
              </div>
              <div className="flex flex-wrap justify-end gap-1">
                {p.authMethods.slice(0, 2).map((m) => (
                  <Badge key={m} variant="secondary">
                    {authLabel(m)}
                  </Badge>
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ─── Step 2: Credentials ────────────────────────────────────────────────────

function CredentialsStep({
  provider,
  auth,
  setAuth,
  form,
  setForm,
  error,
  editing,
}: {
  provider: ReturnType<typeof findProvider>;
  auth: AuthMethod;
  setAuth: (a: AuthMethod) => void;
  form: FormState;
  setForm: (f: FormState) => void;
  error: string | null;
  editing: boolean;
}) {
  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm({ ...form, [key]: value });
  }

  const showOauth = auth === "oauth2";
  const showPassword = auth === "password" || auth === "app_password";

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3 rounded-md border bg-card/40 p-4">
        <div
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-md font-semibold",
            provider.badgeClass,
          )}
        >
          {provider.initial}
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-medium">{provider.name}</div>
          <div className="text-xs text-muted-foreground">{provider.tagline}</div>
          {provider.notes && (
            <div className="mt-2 text-xs text-muted-foreground">
              {provider.notes}
            </div>
          )}
        </div>
        {provider.credentialUrl && (
          <Button asChild variant="outline" size="sm">
            <a
              href={provider.credentialUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              <ExternalLink />
              Get credential
            </a>
          </Button>
        )}
      </div>

      {provider.authMethods.length > 1 && (
        <Field label="Authentication method">
          <Select value={auth} onValueChange={(v) => setAuth(v as AuthMethod)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {provider.authMethods.map((m) => (
                <SelectItem key={m} value={m}>
                  {authLabel(m)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}

      <Section title="Identity">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field
            label="Account id"
            hint={
              editing
                ? "Account id is the primary key and cannot be renamed."
                : "Letters, numbers, _, and - only."
            }
          >
            <Input
              value={form.account_id}
              disabled={editing}
              onChange={(e) =>
                update(
                  "account_id",
                  e.target.value.replace(/[^A-Za-z0-9_-]/g, ""),
                )
              }
              placeholder="default"
            />
          </Field>
          <Field label="Display name" hint="Shown in the accounts list.">
            <Input
              value={form.display_name}
              onChange={(e) => update("display_name", e.target.value)}
              placeholder="Personal Gmail"
            />
          </Field>
        </div>
      </Section>

      <Section title="IMAP (incoming)">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Email address / username">
            <Input
              type="email"
              value={form.imap_user}
              onChange={(e) => update("imap_user", e.target.value)}
              placeholder="you@example.com"
              autoComplete="username"
            />
          </Field>
          {showPassword && (
            <Field
              label={auth === "app_password" ? "App password" : "Password"}
              hint={
                editing
                  ? "Leave empty to keep the current password."
                  : provider.credentialUrl
                    ? "Generate one at the provider, then paste it here."
                    : undefined
              }
            >
              <Input
                type="password"
                value={form.imap_pass}
                placeholder={editing ? "•••••••• (unchanged)" : undefined}
                onChange={(e) =>
                  setForm({
                    ...form,
                    imap_pass: e.target.value,
                    imap_pass_dirty: true,
                  })
                }
                autoComplete="new-password"
              />
            </Field>
          )}
          <Field label="Host">
            <Input
              value={form.imap_host}
              onChange={(e) => update("imap_host", e.target.value)}
            />
          </Field>
          <Field label="Port">
            <Input
              type="number"
              value={form.imap_port}
              onChange={(e) =>
                update("imap_port", Number(e.target.value) || 993)
              }
            />
          </Field>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Switch
            id="imap-secure"
            checked={form.imap_secure}
            onCheckedChange={(c) => update("imap_secure", c)}
          />
          <Label htmlFor="imap-secure">Use TLS</Label>
        </div>
      </Section>

      <Section title="SMTP (outgoing)">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Host">
            <Input
              value={form.smtp_host}
              onChange={(e) => update("smtp_host", e.target.value)}
            />
          </Field>
          <Field label="Port">
            <Input
              type="number"
              value={form.smtp_port}
              onChange={(e) =>
                update("smtp_port", Number(e.target.value) || 587)
              }
            />
          </Field>
          <Field label="Security">
            <Select
              value={form.smtp_security}
              onValueChange={(v) =>
                update("smtp_security", v as FormState["smtp_security"])
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="starttls">STARTTLS</SelectItem>
                <SelectItem value="tls">Implicit TLS</SelectItem>
                <SelectItem value="plain">Plain (no TLS)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Username override" hint="Defaults to the IMAP username.">
            <Input
              value={form.smtp_user}
              onChange={(e) => update("smtp_user", e.target.value)}
              placeholder={form.imap_user || "you@example.com"}
            />
          </Field>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Switch
            id="same-pass"
            checked={form.same_password}
            onCheckedChange={(c) => update("same_password", c)}
          />
          <Label htmlFor="same-pass">
            SMTP uses the same password as IMAP
          </Label>
        </div>
        {!form.same_password && showPassword && (
          <div className="mt-4">
            <Field
              label="SMTP password"
              hint={
                editing ? "Leave empty to keep the current password." : undefined
              }
            >
              <Input
                type="password"
                value={form.smtp_pass}
                placeholder={editing ? "•••••••• (unchanged)" : undefined}
                onChange={(e) =>
                  setForm({
                    ...form,
                    smtp_pass: e.target.value,
                    smtp_pass_dirty: true,
                  })
                }
                autoComplete="new-password"
              />
            </Field>
          </div>
        )}
      </Section>

      {showOauth && (
        <Section title="OAuth2 credentials">
          <Alert>
            <ShieldAlert className="h-4 w-4" />
            <AlertTitle>Refresh token required</AlertTitle>
            <AlertDescription>
              Complete the authorization-code flow against your provider
              first. Paste the resulting <code>refresh_token</code> below
              along with the client id/secret of your registered app.
            </AlertDescription>
          </Alert>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
            <Field label="Provider">
              <Select
                value={form.oauth2_provider}
                onValueChange={(v) => update("oauth2_provider", v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select provider" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="google">google</SelectItem>
                  <SelectItem value="microsoft">microsoft</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Client id">
              <Input
                value={form.oauth2_client_id}
                onChange={(e) => update("oauth2_client_id", e.target.value)}
              />
            </Field>
            <Field
              label="Client secret"
              hint={
                editing
                  ? "Leave empty to keep the current secret."
                  : "Use 'none' for public clients."
              }
            >
              <Input
                type="password"
                value={form.oauth2_client_secret}
                placeholder={editing ? "•••••••• (unchanged)" : undefined}
                onChange={(e) =>
                  update("oauth2_client_secret", e.target.value)
                }
              />
            </Field>
            <Field
              label="Refresh token"
              hint={
                editing
                  ? "Leave empty to keep the current refresh token."
                  : undefined
              }
            >
              <Input
                type="password"
                value={form.oauth2_refresh_token}
                placeholder={editing ? "•••••••• (unchanged)" : undefined}
                onChange={(e) =>
                  update("oauth2_refresh_token", e.target.value)
                }
              />
            </Field>
          </div>
        </Section>
      )}

      {error && (
        <Alert variant="destructive">
          <XCircle className="h-4 w-4" />
          <AlertTitle>Save failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

// ─── Step 3: Verify result ──────────────────────────────────────────────────

function VerifyStep({ result }: { result: VerifyResult }) {
  return (
    <div className="space-y-4">
      <Alert variant={result.overall_ok ? "success" : "destructive"}>
        {result.overall_ok ? (
          <CheckCircle2 className="h-4 w-4" />
        ) : (
          <XCircle className="h-4 w-4" />
        )}
        <AlertTitle>
          {result.overall_ok
            ? "Account verified"
            : "Account saved but verification failed"}
        </AlertTitle>
        <AlertDescription>
          {result.overall_ok
            ? "Every configured protocol responded successfully. You can start using the MCP tools."
            : "Inspect the per-protocol details below and correct the credentials. The account row was still saved."}
        </AlertDescription>
      </Alert>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {result.protocols.map((p) => (
          <Card key={p.protocol}>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <span className="font-medium uppercase">{p.protocol}</span>
                {p.ok ? (
                  <Badge variant="success">ok</Badge>
                ) : (
                  <Badge variant="destructive">error</Badge>
                )}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {p.latency_ms} ms
              </div>
              {p.error && (
                <div className="mt-2 text-xs text-destructive break-words">
                  {p.error}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ─── Layout helpers ─────────────────────────────────────────────────────────

function Stepper({ current }: { current: Step }) {
  const steps: Array<{ id: Step; label: string }> = [
    { id: "provider", label: "Provider" },
    { id: "credentials", label: "Credentials" },
    { id: "verify", label: "Verify" },
  ];
  const idx = steps.findIndex((s) => s.id === current);

  return (
    <div className="flex shrink-0 items-center gap-2 px-6 pt-2 pb-1 text-xs">
      {steps.map((s, i) => (
        <div key={s.id} className="flex items-center gap-2">
          <span
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded-full border",
              i < idx
                ? "bg-primary text-primary-foreground border-primary"
                : i === idx
                  ? "border-primary text-primary"
                  : "border-border text-muted-foreground",
            )}
          >
            {i < idx ? <CheckCircle2 className="h-3.5 w-3.5" /> : i + 1}
          </span>
          <span
            className={cn(
              i === idx ? "font-medium" : "text-muted-foreground",
            )}
          >
            {s.label}
          </span>
          {i < steps.length - 1 && <Separator className="w-6" />}
        </div>
      ))}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section>
      <h3 className="mb-3 text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
