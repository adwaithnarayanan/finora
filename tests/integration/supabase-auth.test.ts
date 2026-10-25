import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { sessionFor } from "../support/google-simulation";

import { adminClient } from "./support/db";

/**
 * Behaviour of the installed Supabase Auth with the local configuration
 * (supabase/config.toml): email/password is the only sign-in method, nobody
 * can sign up, and email links/codes are neutralised. The hosted project must
 * be configured to match; see docs/runbooks/owner-access.md.
 */
const local = inject("local");
const noPersist = { auth: { persistSession: false, autoRefreshToken: false } };
const publicClient = () => createClient(local.apiUrl, local.publishableKey, noPersist);
const adminAuth = createClient(local.apiUrl, local.secretKey, noPersist).auth.admin;

const createdUserIds: string[] = [];
const PASSWORD = `Itest-${randomUUID()}-Aa1`;
const email = () => `itest-${randomUUID()}@finora.test`;
let db: pg.Client;

async function createUser(options: { password?: string; confirmed?: boolean } = {}) {
  const address = email();
  const { data, error } = await adminAuth.createUser({
    email: address,
    email_confirm: options.confirmed ?? true,
    ...(options.password ? { password: options.password } : {}),
  });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.code}`);
  createdUserIds.push(data.user.id);
  return { email: address, id: data.user.id };
}

/** Bodies of the Mailpit messages sent to `address` (local inbox only). */
async function emailsTo(address: string): Promise<string[]> {
  const search = await fetch(`${local.mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`);
  const { messages } = (await search.json()) as { messages: { ID: string }[] };
  return Promise.all(
    messages.map(async ({ ID }) => {
      const message = (await (await fetch(`${local.mailpitUrl}/api/v1/message/${ID}`)).json()) as { HTML: string; Text: string };
      return `${message.HTML}\n${message.Text}`;
    }),
  );
}

async function waitForEmails(address: string, count: number) {
  for (let i = 0; i < 50; i++) {
    const bodies = await emailsTo(address);
    if (bodies.length >= count) return bodies;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`expected ${count} email(s)`);
}

beforeAll(async () => {
  db = await adminClient();
});

afterAll(async () => {
  for (const id of createdUserIds) await adminAuth.deleteUser(id);
  await db.end();
});

describe("enabled sign-in methods", () => {
  it("advertises email as the only provider, sign-ups disabled, confirmations required", async () => {
    const response = await fetch(`${local.apiUrl}/auth/v1/settings`, { headers: { apikey: local.publishableKey } });
    const settings = (await response.json()) as {
      external: Record<string, boolean>;
      disable_signup: boolean;
      mailer_autoconfirm: boolean;
    };
    const enabled = Object.entries(settings.external)
      .filter(([, on]) => on)
      .map(([name]) => name);
    expect(enabled).toEqual(["email"]);
    expect(settings.disable_signup).toBe(true);
    expect(settings.mailer_autoconfirm).toBe(false);
  });

  it("refuses to start Google (or any) OAuth", async () => {
    for (const provider of ["google", "github", "apple"]) {
      const response = await fetch(`${local.apiUrl}/auth/v1/authorize?provider=${provider}`, { redirect: "manual" });
      expect(response.status, provider).toBeGreaterThanOrEqual(400);
    }
  });
});

describe("password sign-in", () => {
  it("issues a verifiable password session to a confirmed user (sign-ups disabled does not block it)", async () => {
    const user = await createUser({ password: PASSWORD });
    const client = publicClient();
    const { data, error } = await client.auth.signInWithPassword({ email: user.email, password: PASSWORD });
    expect(error).toBeNull();
    const claims = (await client.auth.getClaims(data.session!.access_token)).data!.claims;
    expect(claims.sub).toBe(user.id);
    expect((claims["amr"] as { method: string }[]).map((m) => m.method)).toEqual(["password"]);
  });

  it("gives a wrong password and an unknown email the same error", async () => {
    const user = await createUser({ password: PASSWORD });
    const wrong = await publicClient().auth.signInWithPassword({ email: user.email, password: `${PASSWORD}x` });
    const unknown = await publicClient().auth.signInWithPassword({ email: email(), password: PASSWORD });
    expect(wrong.error?.code).toBe("invalid_credentials");
    expect(unknown.error?.code).toBe("invalid_credentials");
    expect(wrong.error?.message).toBe(unknown.error?.message);
  });

  it("refuses an unverified email (Auth says so; the app hides the difference)", async () => {
    const user = await createUser({ password: PASSWORD, confirmed: false });
    const { data, error } = await publicClient().auth.signInWithPassword({ email: user.email, password: PASSWORD });
    expect(error?.code).toBe("email_not_confirmed");
    expect(data.session).toBeNull();
  });

  it("refuses a prepared user that has no password yet", async () => {
    const user = await createUser();
    const { error } = await publicClient().auth.signInWithPassword({ email: user.email, password: PASSWORD });
    expect(error?.code).toBe("invalid_credentials");
  });

  it("enforces the password policy for operator-set passwords", async () => {
    for (const weak of ["short", "alllowercase-123", "NoDigitsInThisOne"]) {
      const { error } = await adminAuth.createUser({ email: email(), password: weak, email_confirm: true });
      expect(error, weak).not.toBeNull();
    }
  });
});

describe("no registration or email-based sign-in", () => {
  it("rejects public sign-ups, including for existing addresses", async () => {
    const existing = await createUser({ password: PASSWORD });
    for (const address of [email(), existing.email]) {
      const { data, error } = await publicClient().auth.signUp({ email: address, password: PASSWORD });
      expect(error?.code).toBe("signup_disabled");
      expect(data.user).toBeNull();
    }
    const otpSignup = await publicClient().auth.signInWithOtp({ email: email() });
    expect(otpSignup.error?.code).toBe("signup_disabled");
  });

  it("sends magic-link and recovery emails without any usable link or code", async () => {
    // Auth still accepts these requests for existing users; the neutralised
    // templates (supabase/templates/no-email-sign-in.html) carry no secret.
    const user = await createUser({ password: PASSWORD });
    expect((await publicClient().auth.signInWithOtp({ email: user.email, options: { shouldCreateUser: false } })).error).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 1100)); // per-address email frequency limit
    expect((await publicClient().auth.resetPasswordForEmail(user.email)).error).toBeNull();

    const bodies = await waitForEmails(user.email, 2);
    for (const body of bodies) {
      const visible = body.replace(/<!--[\s\S]*?-->/g, "");
      expect(visible).not.toMatch(/https?:\/\//);
      expect(visible).not.toMatch(/\d{6,}/);
      expect(visible).toContain("Finora does not sign anyone in");
    }
  });

  it("issues long, short-lived codes, so an unsent code cannot be guessed", async () => {
    const user = await createUser({ password: PASSWORD });
    await publicClient().auth.signInWithOtp({ email: user.email, options: { shouldCreateUser: false } });
    const guess = await publicClient().auth.verifyOtp({ email: user.email, token: "123456", type: "email" });
    expect(guess.error).not.toBeNull();
    expect(guess.data.session).toBeNull();
  });

  it("rejects anonymous, SSO and phone sign-in", async () => {
    expect((await publicClient().auth.signInAnonymously()).error?.code).toBe("anonymous_provider_disabled");
    expect((await publicClient().auth.signInWithSSO({ domain: "finora.test" })).error).not.toBeNull();
    expect((await publicClient().auth.signInWithOtp({ phone: "+15555550100" })).error).not.toBeNull();
  });

  it("rejects a forged access token", async () => {
    const forged = [
      Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url"),
      Buffer.from(
        JSON.stringify({ sub: randomUUID(), role: "authenticated", exp: 4102444800, amr: [{ method: "password" }] }),
      ).toString("base64url"),
      "forged-signature",
    ].join(".");
    const { data, error } = await publicClient().auth.getClaims(forged);
    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });
});

describe("admin-only links (not public, but they exist)", () => {
  // The secret key can still mint magic-link sessions. They record a
  // non-password method in amr, which Finora refuses.
  it("can mint a session, recorded as a non-password sign-in", async () => {
    const user = await createUser({ password: PASSWORD });
    const session = await sessionFor(local, db, user.email, "otp");
    const { data } = await publicClient().auth.getClaims(session.access_token);
    const methods = (data?.claims["amr"] as { method: string }[]).map((entry) => entry.method);
    expect(methods).not.toContain("password");
  });
});
