// /analytics — per-tool usage table.
//
// Counts and durations come from the in-memory ToolStatsRegistry on the
// Rust side. Auto-refreshes every 5 s. Tools that have never been
// invoked appear with zero counters so admins can see the catalog.

import { useEffect, useState } from "react";
import { Activity } from "lucide-react";

import {
  api,
  ApiError,
  type AnalyticsRow,
  type ToolEntry,
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

function relative(ms: number): string {
  if (!ms) return "never";
  const diff = Date.now() - ms;
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

export function AnalyticsPage() {
  const [tools, setTools] = useState<ToolEntry[]>([]);
  const [stats, setStats] = useState<AnalyticsRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    async function load() {
      try {
        const [t, a] = await Promise.all([api.tools(), api.analytics()]);
        if (!live) return;
        setTools(t.tools);
        setStats(a.tools);
        setError(null);
      } catch (e) {
        if (!live) return;
        setError(e instanceof ApiError ? e.body : String(e));
      }
    }
    void load();
    const id = setInterval(load, 5000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);

  const byName = new Map(stats.map((s) => [s.name, s]));
  const totalCalls = stats.reduce((acc, s) => acc + s.total_calls, 0);
  const totalErrors = stats.reduce((acc, s) => acc + s.errors, 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
        <p className="text-sm text-muted-foreground">
          Counters refresh every 5 seconds. Resets on server restart.
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Request failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Tools available" value={tools.length} />
        <Stat label="Total calls" value={totalCalls} />
        <Stat label="Total errors" value={totalErrors} variant="error" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-4 w-4" />
            MCP tools
          </CardTitle>
          <CardDescription>
            All tools the server exposes, with usage counters when present.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tool</TableHead>
                <TableHead className="text-right">Calls</TableHead>
                <TableHead className="text-right">Errors</TableHead>
                <TableHead className="text-right">Avg ms</TableHead>
                <TableHead className="text-right">Max ms</TableHead>
                <TableHead>Last call</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tools.map((t) => {
                const s = byName.get(t.name);
                return (
                  <TableRow key={t.name}>
                    <TableCell>
                      <div className="font-mono text-xs">{t.name}</div>
                      <div className="text-xs text-muted-foreground line-clamp-1">
                        {t.description}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {s?.total_calls ?? 0}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {s?.errors ? (
                        <Badge variant="destructive">{s.errors}</Badge>
                      ) : (
                        <span className="text-muted-foreground">0</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {s?.avg_duration_ms ?? 0}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {s?.max_duration_ms ?? 0}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {relative(s?.last_called_at ?? 0)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({
  label,
  value,
  variant,
}: {
  label: string;
  value: number;
  variant?: "error";
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle
          className={
            variant === "error" && value > 0 ? "text-destructive" : ""
          }
        >
          {value}
        </CardTitle>
      </CardHeader>
    </Card>
  );
}
