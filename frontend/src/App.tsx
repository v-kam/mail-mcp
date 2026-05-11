// Top-level component: auth gate + router.
//
// Routes:
//   /              -> Dashboard (summary + MCP client config + auth notes)
//   /accounts      -> account list + wizard + per-account verify
//   /setup         -> brief setup steps + provider credential deep-links
//   /status        -> per-account status tiles + global health
//   /analytics     -> table of MCP tools with usage counters
//   /settings      -> write/send gate toggles + timeouts (read-only)

import { Loader2 } from "lucide-react";
import { Navigate, Route, Routes } from "react-router-dom";

import { AuthProvider, useAuth } from "@/auth";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Layout } from "@/components/Layout";
import { LoginScreen } from "@/components/LoginScreen";
import { AccountsPage } from "@/pages/AccountsPage";
import { AnalyticsPage } from "@/pages/AnalyticsPage";
import { DashboardPage } from "@/pages/DashboardPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { SetupPage } from "@/pages/SetupPage";
import { StatusPage } from "@/pages/StatusPage";

function AuthedRoutes() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/accounts" element={<AccountsPage />} />
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/status" element={<StatusPage />} />
        <Route path="/analytics" element={<AnalyticsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}

function Inner() {
  const { state } = useAuth();
  if (state.kind === "loading") {
    return (
      <div className="grid min-h-screen place-items-center text-muted-foreground">
        <div className="flex items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="grid min-h-screen place-items-center px-6">
        <Alert variant="destructive" className="max-w-md">
          <AlertTitle>Cannot reach the admin API</AlertTitle>
          <AlertDescription>
            <pre className="mt-2 whitespace-pre-wrap text-xs">
              {state.message}
            </pre>
          </AlertDescription>
        </Alert>
      </div>
    );
  }
  if (!state.authenticated) {
    return <LoginScreen />;
  }
  return <AuthedRoutes />;
}

export default function App() {
  return (
    <AuthProvider>
      <Inner />
    </AuthProvider>
  );
}
