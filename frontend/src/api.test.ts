// Smoke tests for the API client.
//
// Confirms the bearer token wiring (sessionStorage → Authorization
// header) and basic error parsing. End-to-end coverage against the Rust
// admin server lives in .github/workflows/admin-smoke.yml.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, TOKEN_KEY, api } from "./api";

const g = globalThis as { fetch: typeof fetch };

describe("api client", () => {
  const realFetch = g.fetch;
  beforeEach(() => {
    sessionStorage.clear();
  });
  afterEach(() => {
    g.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("sends Authorization header when token is in sessionStorage", async () => {
    sessionStorage.setItem(TOKEN_KEY, "secret-token");
    const fetchSpy = vi
      .fn<(...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>>()
      .mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    g.fetch = fetchSpy as unknown as typeof fetch;

    await api.authCheck();

    expect(fetchSpy).toHaveBeenCalledOnce();
    const init = (fetchSpy.mock.calls[0]?.[1] ?? {}) as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer secret-token",
    );
  });

  it("omits Authorization header when no token is set", async () => {
    const fetchSpy = vi
      .fn<(...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>>()
      .mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    g.fetch = fetchSpy as unknown as typeof fetch;

    await api.authCheck();

    const init = (fetchSpy.mock.calls[0]?.[1] ?? {}) as RequestInit;
    expect(
      (init.headers as Record<string, string>).Authorization,
    ).toBeUndefined();
  });

  it("throws ApiError with status preserved on 4xx/5xx", async () => {
    g.fetch = vi.fn(
      async () => new Response("nope", { status: 401 }),
    ) as unknown as typeof fetch;

    await expect(api.authCheck()).rejects.toBeInstanceOf(ApiError);
    try {
      await api.authCheck();
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(401);
    }
  });
});
