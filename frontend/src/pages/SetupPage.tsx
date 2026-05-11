// /setup — concise reference for setting up a mail-mcp account.
//
// The detailed per-provider how-tos live inside the wizard's Step 2
// (where they are most useful, right next to the form fields). This
// page intentionally stays small: a 3-step elevator pitch and a
// flat list of provider deep-links the user can jump to.

import { ArrowRight, ExternalLink } from "lucide-react";
import { Link } from "react-router-dom";

import { CopyButton } from "@/components/CopyButton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PROVIDERS, authLabel } from "@/lib/providers";

export function SetupPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Setup</h1>
        <p className="text-sm text-muted-foreground">
          Three steps and a list of credential pages — that's it.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>How it works</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="space-y-3 text-sm">
            <li className="flex gap-3">
              <Step n={1} />
              <div>
                <span className="font-medium text-foreground">
                  Mint a credential at your mail provider.
                </span>{" "}
                Most providers want an app password (Gmail, iCloud,
                Yahoo, Fastmail, Zoho). Microsoft 365 wants OAuth2.
                Pick yours from the list below.
              </div>
            </li>
            <li className="flex gap-3">
              <Step n={2} />
              <div>
                <span className="font-medium text-foreground">
                  Add the account here.
                </span>{" "}
                The wizard pre-fills hosts and ports for you.{" "}
                <Link to="/accounts" className="underline">
                  Open the wizard →
                </Link>
              </div>
            </li>
            <li className="flex gap-3">
              <Step n={3} />
              <div>
                <span className="font-medium text-foreground">
                  Wire up your AI client.
                </span>{" "}
                Copy the JSON snippet from the{" "}
                <Link to="/" className="underline">
                  Dashboard
                </Link>{" "}
                into your MCP client config. Pick HTTP{" "}
                (<code>http://&lt;host&gt;/mcp</code>) for a long-running
                container, or stdio (<code>docker exec</code> /{" "}
                <code>npx</code>) for spawn-on-demand setups.
              </div>
            </li>
          </ol>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Provider credential pages</CardTitle>
          <CardDescription>
            Direct deep links. Copy or open, mint the credential, paste
            it into the wizard.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="divide-y">
            {PROVIDERS.map((p) => (
              <div
                key={p.id}
                className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0"
              >
                <div
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md font-semibold ${p.badgeClass}`}
                >
                  {p.initial}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-medium leading-tight">{p.name}</div>
                  <div className="text-xs text-muted-foreground truncate">
                    {p.tagline}
                  </div>
                </div>
                <Badge variant="secondary">
                  {authLabel(p.defaultAuth)}
                </Badge>
                {p.credentialUrl ? (
                  <div className="flex items-center gap-1">
                    <CopyButton value={p.credentialUrl} />
                    <Button
                      asChild
                      variant="outline"
                      size="sm"
                      className="gap-1"
                    >
                      <a
                        href={p.credentialUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        Open <ExternalLink />
                      </a>
                    </Button>
                  </div>
                ) : (
                  <Badge variant="outline">manual</Badge>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Ready?</CardTitle>
          <CardDescription>
            Add the first account and grab the MCP client snippet from
            the dashboard.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button asChild>
            <Link to="/accounts">
              Open wizard <ArrowRight />
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/">
              Go to dashboard <ArrowRight />
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function Step({ n }: { n: number }) {
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-primary/40 text-xs font-medium text-primary">
      {n}
    </span>
  );
}
