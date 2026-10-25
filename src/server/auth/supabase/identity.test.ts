import { describe, expect, it, vi } from "vitest";

import { SupabaseIdentityProvider, claimsToIdentity } from "./identity";

const SUB = "6a1c9a6e-2f39-4a7e-9a7c-1f0d3c2b1a00";

describe("claimsToIdentity", () => {
  it("maps an authenticated user to a provider-scoped identity", () => {
    expect(claimsToIdentity({ sub: SUB, role: "authenticated", is_anonymous: false })).toEqual({
      provider: "supabase",
      subject: SUB,
    });
  });

  it.each([
    ["missing claims", null],
    ["no subject", { role: "authenticated" }],
    ["empty subject", { sub: "", role: "authenticated" }],
    ["oversized subject", { sub: "x".repeat(256), role: "authenticated" }],
    ["anon role", { sub: SUB, role: "anon" }],
    ["service role", { sub: SUB, role: "service_role" }],
    ["anonymous user", { sub: SUB, role: "authenticated", is_anonymous: true }],
    ["non-string subject", { sub: 42, role: "authenticated" }],
  ])("rejects %s", (_label, claims) => {
    expect(claimsToIdentity(claims as Record<string, unknown> | null)).toBeNull();
  });
});

describe("SupabaseIdentityProvider", () => {
  const providerFor = (result: unknown) =>
    new SupabaseIdentityProvider(async () =>
      ({ auth: { getClaims: vi.fn(async () => result) } }) as never,
    );

  it("returns the identity for verified claims", async () => {
    const provider = providerFor({
      data: { claims: { sub: SUB, role: "authenticated" } },
      error: null,
    });
    expect(await provider.getVerifiedIdentity()).toEqual({ provider: "supabase", subject: SUB });
  });

  it("returns null when verification fails or there is no session", async () => {
    expect(await providerFor({ data: null, error: new Error("bad jwt") }).getVerifiedIdentity()).toBeNull();
    expect(await providerFor({ data: null, error: null }).getVerifiedIdentity()).toBeNull();
  });
});
