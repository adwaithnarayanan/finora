import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, inject, it } from "vitest";

/**
 * Behaviour of the local Supabase Auth configuration (supabase/config.toml).
 * The hosted project must be configured to match; see docs/runbooks.
 */
const local = inject("local");
const publicClient = () =>
  createClient(local.apiUrl, local.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
const adminAuth = createClient(local.apiUrl, local.secretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
}).auth.admin;

const createdUserIds: string[] = [];
const PASSWORD = `Itest-${randomUUID()}-Aa1`;
const email = () => `itest-${randomUUID()}@finora.test`;

afterAll(async () => {
  for (const id of createdUserIds) await adminAuth.deleteUser(id);
});

describe("Supabase Auth configuration", () => {
  it("rejects public sign-ups", async () => {
    const { data, error } = await publicClient().auth.signUp({ email: email(), password: PASSWORD });
    expect(error).not.toBeNull();
    expect(data.user).toBeNull();
  });

  it("refuses password sign-in until the email is verified", async () => {
    const address = email();
    const { data } = await adminAuth.createUser({ email: address, password: PASSWORD, email_confirm: false });
    createdUserIds.push(data.user!.id);
    const { error } = await publicClient().auth.signInWithPassword({ email: address, password: PASSWORD });
    expect(error?.code).toBe("email_not_confirmed");
  });

  it("issues a verifiable session to a confirmed user", async () => {
    const address = email();
    const { data } = await adminAuth.createUser({ email: address, password: PASSWORD, email_confirm: true });
    createdUserIds.push(data.user!.id);
    const client = publicClient();
    const signIn = await client.auth.signInWithPassword({ email: address, password: PASSWORD });
    expect(signIn.error).toBeNull();
    const claims = await client.auth.getClaims();
    expect(claims.data?.claims.sub).toBe(data.user!.id);
    expect(claims.data?.claims.role).toBe("authenticated");
  });

  it("rejects a forged access token", async () => {
    const client = publicClient();
    const forged = [
      Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url"),
      Buffer.from(JSON.stringify({ sub: randomUUID(), role: "authenticated", exp: 4102444800 })).toString("base64url"),
      "forged-signature",
    ].join(".");
    const { data, error } = await client.auth.getClaims(forged);
    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });

  it("enforces the password policy", async () => {
    const { error } = await adminAuth.createUser({ email: email(), password: "short", email_confirm: true });
    expect(error).not.toBeNull();
  });

  it("answers password-reset requests identically for known and unknown addresses", async () => {
    const known = email();
    const { data } = await adminAuth.createUser({ email: known, password: PASSWORD, email_confirm: true });
    createdUserIds.push(data.user!.id);
    const forKnown = await publicClient().auth.resetPasswordForEmail(known);
    const forUnknown = await publicClient().auth.resetPasswordForEmail(email());
    expect(forKnown.error).toBeNull();
    expect(forUnknown.error).toBeNull();
    expect(forUnknown.data).toEqual(forKnown.data);
  });
});
