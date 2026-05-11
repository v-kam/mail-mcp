// React context that gates the UI behind the admin bearer token.
//
// On mount we hit `/api/health` (which is unauthenticated) to learn
// whether a token is required at all. When required and missing, the UI
// renders the LoginScreen until the user provides a valid token (proven
// by `/api/auth/check` succeeding).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { api, ApiError, TOKEN_KEY, type Health } from "./api";

type AuthState =
  | { kind: "loading" }
  | { kind: "ready"; health: Health; authenticated: boolean }
  | { kind: "error"; message: string };

type AuthContextValue = {
  state: AuthState;
  login: (token: string) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ kind: "loading" });

  const refresh = useCallback(async () => {
    try {
      const health = await api.health();
      let authenticated = !health.admin_token_required;
      if (health.admin_token_required && sessionStorage.getItem(TOKEN_KEY)) {
        try {
          await api.authCheck();
          authenticated = true;
        } catch {
          authenticated = false;
        }
      }
      setState({ kind: "ready", health, authenticated });
    } catch (e) {
      const message = e instanceof Error ? e.message : "unknown error";
      setState({ kind: "error", message });
    }
  }, []);

  const login = useCallback(
    async (token: string) => {
      sessionStorage.setItem(TOKEN_KEY, token);
      try {
        await api.authCheck();
        await refresh();
      } catch (e) {
        sessionStorage.removeItem(TOKEN_KEY);
        if (e instanceof ApiError && e.status === 401) {
          throw new Error("Invalid token");
        }
        throw e;
      }
    },
    [refresh],
  );

  const logout = useCallback(() => {
    sessionStorage.removeItem(TOKEN_KEY);
    setState((prev) =>
      prev.kind === "ready" ? { ...prev, authenticated: false } : prev,
    );
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<AuthContextValue>(
    () => ({ state, login, logout, refresh }),
    [state, login, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used inside <AuthProvider>");
  }
  return ctx;
}
