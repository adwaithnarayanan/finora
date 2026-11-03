import { describe, expect, it, vi } from "vitest";

import {
  ACTIVE_POLICY,
  APPROVED_GOOGLE_ID_KEY,
  APPROVED_PASSWORD_EMAIL_KEY,
  GOOGLE_POLICY,
  PASSWORD_POLICY,
  SupabaseIdentityProvider,
  claimsToIdentity,
  hasApprovedGoogleIdentity,
  hasApprovedPasswordAccount,
} from "./identity";
import { ACTIVE_SIGN_IN_METHOD } from "./sign-in-method";

const SUB = "6a1c9a6e-2f39-4a7e-9a7c-1f0d3c2b1a00";
const GOOGLE_ID = "109876543210987654321";
const EMAIL = "owner@example.com";
const oauth = [{ method: "oauth", timestamp: 1 }];
const password = [{ method: "password", timestamp: 1 }];
const claims = (extra: Record<string, unknown> = {}) => ({
  sub: SUB,
  role: "authenticated",
  amr: password,
  ...extra,
});

const googleIdentity = (
  id = GOOGLE_ID,
  extra: Record<string, unknown> = {},
) => ({
  id,
  provider: "google",
  identity_data: { sub: id, email: "owner@example.com", email_verified: true },
  ...extra,
});
const emailIdentity = {
  id: SUB,
  provider: "email",
  identity_data: { email_verified: false },
};
const user = (identities: unknown[], approved: unknown = GOOGLE_ID) => ({
  id: SUB,
  app_metadata: {
    provider: "email",
    providers: ["email", "google"],
    ...(approved === null ? {} : { [APPROVED_GOOGLE_ID_KEY]: approved }),
  },
  identities,
});

const passwordUser = (
  extra: Record<string, unknown> = {},
  approved: unknown = EMAIL,
) => ({
  id: SUB,
  email: EMAIL,
  email_confirmed_at: "2026-10-25T00:00:00Z",
  app_metadata: {
    provider: "email",
    providers: ["email"],
    ...(approved === null ? {} : { [APPROVED_PASSWORD_EMAIL_KEY]: approved }),
  },
  identities: [{ id: SUB, provider: "email", identity_data: { email: EMAIL } }],
  ...extra,
});

describe("active sign-in method", () => {
  it("is email/password, with Google deferred", () => {
    expect(ACTIVE_SIGN_IN_METHOD).toBe("password");
    expect(ACTIVE_POLICY).toBe(PASSWORD_POLICY);
    expect(PASSWORD_POLICY.amrMethod).toBe("password");
    expect(GOOGLE_POLICY.amrMethod).toBe("oauth");
  });
});

describe("claimsToIdentity", () => {
  it("maps a password-authenticated user to a provider-scoped identity", () => {
    expect(claimsToIdentity({ ...claims(), is_anonymous: false })).toEqual({
      provider: "supabase",
      subject: SUB,
    });
  });

  it("accepts OAuth sessions only under the (deferred) Google policy", () => {
    expect(claimsToIdentity(claims({ amr: oauth }))).toBeNull();
    expect(
      claimsToIdentity(claims({ amr: oauth }), GOOGLE_POLICY.amrMethod),
    ).toEqual({ provider: "supabase", subject: SUB });
    expect(claimsToIdentity(claims(), GOOGLE_POLICY.amrMethod)).toBeNull();
  });

  it.each([
    ["missing claims", null],
    ["no subject", { role: "authenticated", amr: password }],
    ["empty subject", claims({ sub: "" })],
    ["oversized subject", claims({ sub: "x".repeat(256) })],
    ["anon role", claims({ role: "anon" })],
    ["service role", claims({ role: "service_role" })],
    ["anonymous user", claims({ is_anonymous: true })],
    ["non-string subject", claims({ sub: 42 })],
    ["OAuth (Google) session", claims({ amr: oauth })],
    [
      "magic link / OTP session",
      claims({ amr: [{ method: "otp", timestamp: 1 }] }),
    ],
    [
      "recovery link session",
      claims({ amr: [{ method: "recovery", timestamp: 1 }] }),
    ],
    [
      "invite link session",
      claims({ amr: [{ method: "invite", timestamp: 1 }] }),
    ],
    ["passkey session", claims({ amr: [{ method: "passkey", timestamp: 1 }] })],
    ["missing amr", claims({ amr: undefined })],
    ["malformed amr", claims({ amr: "password" })],
    [
      "amr with junk entries",
      claims({ amr: [null, "password", { method: "PASSWORD" }] }),
    ],
  ])("rejects %s", (_label, value) => {
    expect(
      claimsToIdentity(value as Record<string, unknown> | null),
    ).toBeNull();
  });
});

describe("hasApprovedPasswordAccount", () => {
  it("accepts the approved, confirmed email account", () => {
    expect(hasApprovedPasswordAccount(passwordUser() as never)).toBe(true);
    expect(
      hasApprovedPasswordAccount(
        passwordUser({ email: "Owner@Example.com" }) as never,
      ),
    ).toBe(true);
  });

  it.each([
    ["no approval recorded", passwordUser({}, null)],
    ["empty approval", passwordUser({}, "")],
    ["non-string approval", passwordUser({}, true)],
    [
      "email changed since approval",
      passwordUser({ email: "other@example.com" }),
    ],
    ["unconfirmed email", passwordUser({ email_confirmed_at: null })],
    ["empty confirmation", passwordUser({ email_confirmed_at: "" })],
    ["no email identity", passwordUser({ identities: [] })],
    ["identities missing", passwordUser({ identities: undefined })],
    ["no email at all", passwordUser({ email: undefined })],
    ["app_metadata missing", passwordUser({ app_metadata: undefined })],
  ])("rejects %s", (_label, value) => {
    expect(hasApprovedPasswordAccount(value as never)).toBe(false);
  });
});

describe("hasApprovedGoogleIdentity (deferred)", () => {
  it("accepts the approved, verified Google identity (an unusable email identity may coexist)", () => {
    expect(hasApprovedGoogleIdentity(user([googleIdentity()]) as never)).toBe(
      true,
    );
    expect(
      hasApprovedGoogleIdentity(
        user([emailIdentity, googleIdentity()]) as never,
      ),
    ).toBe(true);
  });

  it.each([
    ["no approval recorded", user([googleIdentity()], null)],
    ["empty approval", user([googleIdentity()], "")],
    ["non-string approval", user([googleIdentity()], 123)],
    [
      "a different Google account (same email)",
      user([googleIdentity("200000000000000000001")]),
    ],
    [
      "a second Google account linked",
      user([googleIdentity(), googleIdentity("200000000000000000001")]),
    ],
    [
      "another provider linked as well",
      user([
        googleIdentity(),
        { id: "gh-1", provider: "github", identity_data: {} },
      ]),
    ],
    [
      "approval id on a non-Google provider",
      user([{ ...googleIdentity(), provider: "github" }]),
    ],
    [
      "unverified Google email",
      user([
        googleIdentity(GOOGLE_ID, { identity_data: { email_verified: false } }),
      ]),
    ],
    ["no identities", user([])],
    [
      "identities missing",
      { app_metadata: { [APPROVED_GOOGLE_ID_KEY]: GOOGLE_ID } },
    ],
    ["app_metadata missing", { identities: [googleIdentity()] }],
  ])("rejects %s", (_label, value) => {
    expect(hasApprovedGoogleIdentity(value as never)).toBe(false);
  });
});

describe("SupabaseIdentityProvider", () => {
  const providerFor = (
    claimsResult: unknown,
    userResult: unknown = { data: { user: passwordUser() }, error: null },
    policy = PASSWORD_POLICY,
  ) => {
    const auth = {
      getClaims: vi.fn(async () => claimsResult),
      getUser: vi.fn(async () => userResult),
    };
    return {
      auth,
      provider: new SupabaseIdentityProvider(
        async () => ({ auth }) as never,
        policy,
      ),
    };
  };
  const ok = { data: { claims: claims() }, error: null };

  it("uses the active (password) policy by default", async () => {
    const auth = {
      getClaims: vi.fn(async () => ok),
      getUser: vi.fn(async () => ({
        data: { user: passwordUser() },
        error: null,
      })),
    };
    expect(
      await new SupabaseIdentityProvider(
        async () => ({ auth }) as never,
      ).getVerifiedIdentity(),
    ).toEqual({
      provider: "supabase",
      subject: SUB,
    });
  });

  it("returns the identity for a verified password session of the approved account", async () => {
    const { provider, auth } = providerFor(ok);
    expect(await provider.getVerifiedIdentity()).toEqual({
      provider: "supabase",
      subject: SUB,
    });
    expect(auth.getUser).toHaveBeenCalledOnce();
  });

  it("applies the Google policy when given it (deferred mode)", async () => {
    const google = { data: { user: user([googleIdentity()]) }, error: null };
    const oauthClaims = {
      data: { claims: claims({ amr: oauth }) },
      error: null,
    };
    expect(
      await providerFor(
        oauthClaims,
        google,
        GOOGLE_POLICY,
      ).provider.getVerifiedIdentity(),
    ).not.toBeNull();
    expect(
      await providerFor(ok, google).provider.getVerifiedIdentity(),
    ).toBeNull();
    expect(
      await providerFor(
        oauthClaims,
        { data: { user: passwordUser() }, error: null },
        GOOGLE_POLICY,
      ).provider.getVerifiedIdentity(),
    ).toBeNull();
  });

  it("returns null when verification fails or there is no session, without calling getUser", async () => {
    for (const result of [
      { data: null, error: new Error("bad jwt") },
      { data: null, error: null },
    ]) {
      const { provider, auth } = providerFor(result);
      expect(await provider.getVerifiedIdentity()).toBeNull();
      expect(auth.getUser).not.toHaveBeenCalled();
    }
  });

  it("returns null for sessions from another sign-in method without calling getUser", async () => {
    const { provider, auth } = providerFor({
      data: { claims: claims({ amr: [{ method: "otp" }] }) },
      error: null,
    });
    expect(await provider.getVerifiedIdentity()).toBeNull();
    expect(auth.getUser).not.toHaveBeenCalled();
  });

  it.each([
    [
      "the Auth server rejects the session",
      { data: { user: null }, error: new Error("session revoked") },
    ],
    [
      "the user differs from the token subject",
      { data: { user: passwordUser({ id: "other" }) }, error: null },
    ],
    [
      "the account is not approved",
      { data: { user: passwordUser({}, null) }, error: null },
    ],
  ])("returns null when %s", async (_label, userResult) => {
    expect(
      await providerFor(ok, userResult).provider.getVerifiedIdentity(),
    ).toBeNull();
  });
});
