import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { authorizeOwner } from "@/server/auth/authorize";
import {
  APPROVED_GOOGLE_ID_KEY,
  APPROVED_PASSWORD_EMAIL_KEY,
  GOOGLE_POLICY,
  SupabaseIdentityProvider,
} from "@/server/auth/supabase/identity";
import { PrismaOwnerDirectory } from "@/server/db/owner-directory";

import { complete, prepare, setPassword } from "../../scripts/lib/provisioning.mjs";
import { clientWithSession, linkSimulatedGoogleIdentity, sessionFor } from "../support/google-simulation";

import { adminClient, appPrisma, deleteOwners } from "./support/db";

/**
 * Owner authorisation against the real local Auth server and database, using
 * the app's adapter (getClaims + getUser, active = password policy) and owner
 * directory. Sessions come from real password logins.
 */

const local = inject("local");
const noPersist = { auth: { persistSession: false, autoRefreshToken: false } };
const adminAuth = createClient(local.apiUrl, local.secretKey, noPersist).auth.admin;
const prisma = appPrisma();
let db: pg.Client;
const userIds: string[] = [];
const ownerIds: string[] = [];

const PASSWORD = `Itest-${randomUUID().slice(0, 8)}-Aa1`;

async function passwordUser(options: { confirmed?: boolean } = {}) {
  const email = `itest-access-${randomUUID().slice(0, 8)}@finora.test`;
  const { data, error } = await adminAuth.createUser({ email, password: PASSWORD, email_confirm: options.confirmed ?? true });
  if (error || !data.user) throw new Error(`createUser: ${error?.code}`);
  userIds.push(data.user.id);
  return { id: data.user.id, email };
}

/** A fully provisioned owner, through the real operator workflow. */
async function provisionedOwner() {
  const email = `itest-owner-${randomUUID().slice(0, 8)}@finora.test`;
  const { userId } = await prepare({ admin: adminAuth, db, email, purpose: "additional-owner" });
  userIds.push(userId);
  await setPassword({ admin: adminAuth, db, email, password: PASSWORD });
  const { ownerId } = await complete({ admin: adminAuth, db, email, allowAdditional: true });
  ownerIds.push(ownerId);
  return { id: userId, email, ownerId: ownerId as string };
}

async function passwordSessionClient(email: string, password = PASSWORD) {
  const client = createClient(local.apiUrl, local.publishableKey, noPersist);
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`signInWithPassword: ${error.code}`);
  return client;
}

const authorize = (client: object, policy?: typeof GOOGLE_POLICY) =>
  authorizeOwner({
    identities: new SupabaseIdentityProvider(async () => client as never, policy),
    owners: new PrismaOwnerDirectory(prisma),
  });

beforeAll(async () => {
  db = await adminClient();
});

afterAll(async () => {
  await deleteOwners(db, ownerIds);
  for (const id of userIds) await adminAuth.deleteUser(id);
  await db.end();
  await prisma.$disconnect();
});

describe("email/password owner access", () => {
  it("authorises the provisioned owner's password session as its internal owner id", async () => {
    const owner = await provisionedOwner();
    const access = await authorize(await passwordSessionClient(owner.email));
    expect(access).toMatchObject({ status: "authorized", owner: { ownerId: owner.ownerId } });
    if (access.status === "authorized") expect(access.owner.ownerId).not.toBe(owner.id);
  });

  it("does not make a user an owner by signing in (no automatic owner creation)", async () => {
    const user = await passwordUser();
    const before = (await db.query("SELECT count(*)::int AS n FROM finora.owners")).rows[0].n;
    expect(await authorize(await passwordSessionClient(user.email))).toEqual({ status: "unauthenticated" });
    const after = (await db.query("SELECT count(*)::int AS n FROM finora.owners")).rows[0].n;
    expect(after).toBe(before);
    expect((await db.query("SELECT 1 FROM finora.owner_identities WHERE subject = $1", [user.id])).rowCount).toBe(0);
  });

  it("does not authorise on an email match: approval without a mapping is refused", async () => {
    const user = await passwordUser();
    await adminAuth.updateUserById(user.id, { app_metadata: { [APPROVED_PASSWORD_EMAIL_KEY]: user.email } });
    expect(await authorize(await passwordSessionClient(user.email))).toEqual({ status: "forbidden", reason: "no-owner" });
  });

  it("refuses a mapped owner whose approval was withdrawn or whose email changed", async () => {
    const owner = await provisionedOwner();
    await adminAuth.updateUserById(owner.id, { app_metadata: { [APPROVED_PASSWORD_EMAIL_KEY]: "someone-else@finora.test" } });
    expect(await authorize(await passwordSessionClient(owner.email))).toEqual({ status: "unauthenticated" });
    await adminAuth.updateUserById(owner.id, { app_metadata: { [APPROVED_PASSWORD_EMAIL_KEY]: null } });
    expect(await authorize(await passwordSessionClient(owner.email))).toEqual({ status: "unauthenticated" });
  });

  it("refuses an inactive (disabled) owner", async () => {
    const owner = await provisionedOwner();
    await db.query("UPDATE finora.owners SET disabled_at = now() WHERE id = $1", [owner.ownerId]);
    expect(await authorize(await passwordSessionClient(owner.email))).toEqual({ status: "forbidden", reason: "disabled" });
  });

  it("refuses the owner's account when the session was not a password login (admin magic link)", async () => {
    const owner = await provisionedOwner();
    const client = await clientWithSession(local, await sessionFor(local, db, owner.email, "otp"));
    expect(await authorize(client)).toEqual({ status: "unauthenticated" });
  });

  it("refuses a signed-out (revoked) session even though its access token has not expired", async () => {
    const owner = await provisionedOwner();
    const client = await passwordSessionClient(owner.email);
    const token = (await client.auth.getSession()).data.session!.access_token;
    const anonymous = createClient(local.apiUrl, local.publishableKey, noPersist);
    // Present exactly this token, as a stolen cookie would.
    const replay = { auth: { getClaims: () => anonymous.auth.getClaims(token), getUser: () => anonymous.auth.getUser(token) } };
    const identities = new SupabaseIdentityProvider(async () => replay as never);
    expect(await identities.getVerifiedIdentity()).not.toBeNull();
    await client.auth.signOut({ scope: "local" });
    expect((await anonymous.auth.getClaims(token)).data).not.toBeNull(); // signature alone still verifies
    expect(await identities.getVerifiedIdentity()).toBeNull(); // getUser sees the revocation
  });

  it("revokes every session when the password is rotated", async () => {
    const owner = await provisionedOwner();
    const client = await passwordSessionClient(owner.email);
    expect((await authorize(client)).status).toBe("authorized");
    const rotated = `Rotated-${randomUUID().slice(0, 8)}-Aa1`;
    const { remainingSessions } = await setPassword({ admin: adminAuth, db, email: owner.email, password: rotated });
    expect(remainingSessions).toBe(0);
    expect(await authorize(client)).toEqual({ status: "unauthenticated" });
    await expect(passwordSessionClient(owner.email)).rejects.toThrow(/invalid_credentials/);
    expect((await authorize(await passwordSessionClient(owner.email, rotated))).status).toBe("authorized");
  });
});

describe("deferred Google OAuth cannot bypass the password policy", () => {
  it("refuses an OAuth session for the owner, even with an approved Google identity", async () => {
    const owner = await provisionedOwner();
    const googleId = await linkSimulatedGoogleIdentity(db, owner);
    await adminAuth.updateUserById(owner.id, { app_metadata: { [APPROVED_GOOGLE_ID_KEY]: googleId } });
    const oauthClient = await clientWithSession(local, await sessionFor(local, db, owner.email, "oauth"));
    expect(await authorize(oauthClient)).toEqual({ status: "unauthenticated" });
    // The same session would satisfy the (inactive) Google policy, proving the
    // refusal comes from the active method, not from a broken session.
    expect((await authorize(oauthClient, GOOGLE_POLICY)).status).toBe("authorized");
  });
});
