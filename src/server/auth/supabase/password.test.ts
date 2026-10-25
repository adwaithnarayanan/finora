import { describe, expect, it, vi } from "vitest";

import { signInWithEmailPassword } from "./password";
import { endSession } from "./sign-out";

const clientWith = (auth: Record<string, unknown>) => async () => ({ auth }) as never;

describe("signInWithEmailPassword", () => {
  it("signs in with the given credentials", async () => {
    const signInWithPassword = vi.fn(async () => ({ data: { session: { access_token: "t" } }, error: null }));
    expect(await signInWithEmailPassword(clientWith({ signInWithPassword }), "a@b.co", "pw")).toBe("signed-in");
    expect(signInWithPassword).toHaveBeenCalledWith({ email: "a@b.co", password: "pw" });
  });

  it.each([
    ["wrong password / unknown email", { status: 400, code: "invalid_credentials" }],
    ["unverified email", { status: 400, code: "email_not_confirmed" }],
    ["disabled provider", { status: 422, code: "email_provider_disabled" }],
    ["server error", { status: 500, code: "unexpected_failure" }],
  ])("collapses %s into one generic failure", async (_label, error) => {
    const signInWithPassword = vi.fn(async () => ({ data: { session: null }, error }));
    expect(await signInWithEmailPassword(clientWith({ signInWithPassword }), "a@b.co", "pw")).toBe("failed");
  });

  it("reports rate limiting, which applies to every address alike", async () => {
    const signInWithPassword = vi.fn(async () => ({ data: { session: null }, error: { status: 429 } }));
    expect(await signInWithEmailPassword(clientWith({ signInWithPassword }), "a@b.co", "pw")).toBe("rate-limited");
  });

  it("treats a response without a session as a failure", async () => {
    const signInWithPassword = vi.fn(async () => ({ data: { session: null }, error: null }));
    expect(await signInWithEmailPassword(clientWith({ signInWithPassword }), "a@b.co", "pw")).toBe("failed");
  });
});

describe("endSession", () => {
  it("signs out this device only", async () => {
    const signOut = vi.fn(async () => ({ error: null }));
    await endSession(clientWith({ signOut }));
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
  });
});
