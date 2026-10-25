import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SupabaseIdentityProvider } from "./identity";
import { OAUTH_CALLBACK_PATH, completeOAuthSignIn, startGoogleSignIn } from "./oauth";

const SUPABASE_URL = "https://abcd.supabase.co";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://finora.example");
  vi.stubEnv("SUPABASE_URL", SUPABASE_URL);
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_0123456789abcdefghij");
  vi.resetModules();
});

afterEach(() => vi.unstubAllEnvs());

function fakeClient(auth: Record<string, unknown>) {
  return async () => ({ auth }) as never;
}

describe("startGoogleSignIn", () => {
  it("starts Google OAuth with the exact callback URL and account chooser", async () => {
    const signInWithOAuth = vi.fn(async () => ({
      data: { url: `${SUPABASE_URL}/auth/v1/authorize?provider=google&code_challenge=x` },
      error: null,
    }));
    const { startGoogleSignIn: start } = await import("./oauth");
    expect(await start(fakeClient({ signInWithOAuth }))).toBe(
      `${SUPABASE_URL}/auth/v1/authorize?provider=google&code_challenge=x`,
    );
    expect(signInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: {
        redirectTo: `https://finora.example${OAUTH_CALLBACK_PATH}`,
        queryParams: { prompt: "select_account" },
      },
    });
  });

  it.each([
    ["an error", { data: { url: null }, error: new Error("provider disabled") }],
    ["no URL", { data: { url: null }, error: null }],
    ["an unparsable URL", { data: { url: "not a url" }, error: null }],
    ["a URL on another origin", { data: { url: "https://evil.example/auth/v1/authorize" }, error: null }],
  ])("refuses to redirect on %s", async (_label, result) => {
    expect(await startGoogleSignIn(fakeClient({ signInWithOAuth: vi.fn(async () => result) }))).toBeNull();
  });
});

describe("completeOAuthSignIn", () => {
  it("exchanges the code and returns an identity provider bound to the new session", async () => {
    const exchangeCodeForSession = vi.fn(async () => ({ data: {}, error: null }));
    const result = await completeOAuthSignIn(fakeClient({ exchangeCodeForSession }), "code-1234-abcd");
    expect(exchangeCodeForSession).toHaveBeenCalledWith("code-1234-abcd");
    expect(result).toBeInstanceOf(SupabaseIdentityProvider);
  });

  it("returns null when the exchange fails (bad code, missing PKCE verifier)", async () => {
    const exchangeCodeForSession = vi.fn(async () => ({ data: {}, error: new Error("invalid flow state") }));
    expect(await completeOAuthSignIn(fakeClient({ exchangeCodeForSession }), "code-1234-abcd")).toBeNull();
  });
});
