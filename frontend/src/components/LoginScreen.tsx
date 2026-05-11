// Bearer-token login screen.
//
// Rendered when /api/health reports `admin_token_required: true` and we
// don't yet have a valid token in sessionStorage. The token is verified
// against /api/auth/check before storing.

import { useState, type FormEvent } from "react";
import { Loader2, Lock } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/auth";

export function LoginScreen() {
  const { login } = useAuth();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(token);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-md bg-primary/15 text-primary">
            <Lock className="h-5 w-5" />
          </div>
          <CardTitle className="text-center">mail-mcp admin</CardTitle>
          <CardDescription className="text-center">
            Paste the value of <code>MAIL_MCP_ADMIN_TOKEN</code> to sign in.
          </CardDescription>
        </CardHeader>
        <form onSubmit={submit}>
          <CardContent className="space-y-3">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="token">Token</Label>
              <Input
                id="token"
                type="password"
                autoComplete="current-password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                disabled={busy}
                autoFocus
              />
            </div>
          </CardContent>
          <CardFooter>
            <Button type="submit" disabled={busy || !token} className="w-full">
              {busy && <Loader2 className="animate-spin" />}
              Sign in
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
