// App shell — top bar with version + sign-out, side navigation.
//
// Renders a "store read-only" warning when MAIL_MCP_ADMIN_KEY is unset
// so the user immediately sees why writes might fail.

import { type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import {
  Activity,
  BarChart3,
  BookOpen,
  Home,
  LogOut,
  Settings,
  Shield,
  Users,
} from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useAuth } from "@/auth";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/", label: "Dashboard", icon: Home, end: true },
  { to: "/accounts", label: "Accounts", icon: Users },
  { to: "/setup", label: "Setup", icon: BookOpen },
  { to: "/status", label: "Status", icon: Activity },
  { to: "/analytics", label: "Analytics", icon: BarChart3 },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function Layout({ children }: { children: ReactNode }) {
  const { state, logout } = useAuth();
  const writable =
    state.kind === "ready" ? state.health.store_writable : true;
  const tokenRequired =
    state.kind === "ready" ? state.health.admin_token_required : false;
  const version = state.kind === "ready" ? state.health.version : "";

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b bg-card">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/15 text-primary">
              <Shield className="h-4 w-4" />
            </div>
            <div>
              <div className="font-semibold tracking-tight">mail-mcp</div>
              <div className="text-xs text-muted-foreground">
                Email MCP server admin
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {version && (
              <Badge variant="outline" className="font-mono">
                v{version}
              </Badge>
            )}
            {tokenRequired && (
              <Button variant="ghost" size="sm" onClick={logout}>
                <LogOut />
                Sign out
              </Button>
            )}
          </div>
        </div>
      </header>

      {!writable && (
        <Alert variant="warning" className="rounded-none border-x-0 border-t-0">
          <AlertDescription>
            Read-only mode &mdash; set <code>MAIL_MCP_ADMIN_KEY</code> on
            the container to enable persistent account writes.
          </AlertDescription>
        </Alert>
      )}

      <div className="mx-auto grid w-full max-w-6xl flex-1 grid-cols-[180px_1fr] gap-8 px-6 py-8">
        <nav className="sticky top-8 self-start space-y-1">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                  isActive
                    ? "bg-primary/15 text-primary"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                )
              }
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </NavLink>
          ))}
          <Separator className="my-3" />
          <a
            href="https://github.com/tecnologicachile/mail-mcp"
            target="_blank"
            rel="noreferrer noopener"
            className="block px-3 py-2 text-xs text-muted-foreground hover:text-foreground"
          >
            GitHub →
          </a>
        </nav>

        <main className="min-w-0">{children}</main>
      </div>
    </div>
  );
}
