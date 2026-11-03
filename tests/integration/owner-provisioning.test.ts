import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import type pg from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  inject,
  it,
} from "vitest";

import {
  APPROVED_GOOGLE_ID_KEY,
  APPROVED_PASSWORD_EMAIL_KEY,
  cancel,
  complete,
  prepare,
  relink,
  setPassword,
  soleGoogleIdentity,
} from "../../scripts/lib/provisioning.mjs";
import {
  linkSimulatedGoogleIdentity,
  randomGoogleId,
} from "../support/google-simulation";

import { adminClient, deleteOwners } from "./support/db";
import { type CleanupStep, runCleanup } from "./support/cleanup";
import {
  type ScratchDatabase,
  createMigratedScratchDatabase,
} from "./support/scratch-db";

const local = inject("local");
const adminAuth = createClient(local.apiUrl, local.secretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
}).auth.admin;
let db: pg.Client;
let authDb: pg.Client;
let scratch: ScratchDatabase | undefined;
const emails: string[] = [];
const ownerIds: string[] = [];

const newEmail = () => {
  const email = `itest-prov-${Date.now()}-${emails.length}@finora.test`;
  emails.push(email);
  return email;
};

async function userByEmail(email: string) {
  const { data } = await adminAuth.listUsers({ perPage: 1000 });
  const found = data.users.find((u) => u.email === email);
  return found ? (await adminAuth.getUserById(found.id)).data.user! : null;
}

async function mapping(userId: string) {
  const { rows } = await db.query(
    "SELECT owner_id::text FROM finora.owner_identities WHERE provider = 'supabase' AND subject = $1",
    [userId],
  );
  return rows[0]?.owner_id ?? null;
}

async function ownerCount() {
  const { rows } = await db.query(
    "SELECT count(*)::int AS n FROM finora.owners",
  );
  return rows[0].n as number;
}

beforeAll(async () => {
  authDb = await adminClient();
  scratch = await createMigratedScratchDatabase("provisioning");
  db = scratch.client;
  if ((await ownerCount()) > 0)
    throw new Error("the scratch database must start without owners");
});

afterEach(async () => {
  for (const email of emails) {
    const user = await userByEmail(email);
    const owner = user ? await mapping(user.id) : null;
    if (owner && !ownerIds.includes(owner)) ownerIds.push(owner);
  }
  await deleteOwners(db, ownerIds.splice(0));
});

afterAll(async () => {
  await runCleanup([
    ...emails.map((email): CleanupStep => [
      `delete Auth user ${email}`,
      async () => {
        const user = await userByEmail(email);
        if (!user) return;
        const { error } = await adminAuth.deleteUser(user.id);
        if (error)
          throw new Error(
            `Supabase Auth refused (${error.code ?? error.status})`,
          );
      },
    ]),
    ["drop the scratch database", async () => scratch?.drop()],
    ["close the Auth database connection", async () => authDb?.end()],
  ]);
});

const ctx = () => ({ admin: adminAuth, db });
const authCtx = () => ({ admin: adminAuth, db: authDb });
const strongPassword = () => `Prov-${randomUUID().slice(0, 8)}-Aa1`;

async function canSignIn(email: string, password: string) {
  const client = createClient(local.apiUrl, local.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  return error === null;
}

function cli(args: string[], stdin?: string) {
  const result = spawnSync(
    "node",
    ["scripts/owner/provision.mjs", ...args, "--local"],
    {
      input: stdin,
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  return {
    status: result.status,
    output: `${result.stdout}\n${result.stderr}`,
  };
}

async function passwordOwner(
  email = newEmail(),
  password = strongPassword(),
  options = {},
) {
  const { userId } = await prepare({ ...ctx(), email, ...options });
  await setPassword({ ...authCtx(), email, password });
  const result = await complete({
    ...ctx(),
    email,
    ...("purpose" in options ? { allowAdditional: true } : {}),
  });
  ownerIds.push(result.ownerId);
  return { email, password, userId, ownerId: result.ownerId as string };
}

describe("prepare", () => {
  it("creates a passwordless user that grants nothing on its own", async () => {
    const email = newEmail();
    const { userId, created } = await prepare({ ...ctx(), email });
    expect(created).toBe(true);
    const user = await userByEmail(email);
    expect(user!.id).toBe(userId);
    expect(user!.app_metadata[APPROVED_GOOGLE_ID_KEY]).toBeUndefined();
    expect(user!.identities!.map((i) => i.provider)).toEqual(["email"]);
    expect(await mapping(userId)).toBeNull();
    expect(await ownerCount()).toBe(0);
    expect(await prepare({ ...ctx(), email })).toEqual({
      userId,
      created: false,
    });
  });
});

describe("set-password", () => {
  it("sets a password the user can sign in with, after validating it", async () => {
    const email = newEmail();
    await prepare({ ...ctx(), email });
    await expect(
      setPassword({ ...authCtx(), email, password: "too-weak" }),
    ).rejects.toThrow(/Password rejected/);
    const password = strongPassword();
    await setPassword({ ...authCtx(), email, password });
    expect(await canSignIn(email, password)).toBe(true);
  });

  it("refuses unknown users", async () => {
    await expect(
      setPassword({
        ...authCtx(),
        email: newEmail(),
        password: strongPassword(),
      }),
    ).rejects.toThrow(/No Supabase user/);
  });

  it("through the CLI: reads the password from stdin and never prints it", async () => {
    const email = newEmail();
    await prepare({ ...ctx(), email });
    const password = strongPassword();
    const run = cli(
      ["set-password", "--email", email, "--password-stdin"],
      `${password}\n`,
    );
    expect(run.status).toBe(0);
    expect(run.output).toContain("Password set.");
    expect(run.output).not.toContain(password);
    expect(await canSignIn(email, password)).toBe(true);
  });

  it("through the CLI: a rejected password is not echoed either", () => {
    const email = newEmail();
    const weak = "weakpassword-without-upper";
    const run = cli(
      ["set-password", "--email", email, "--password-stdin"],
      weak,
    );
    expect(run.status).toBe(1);
    expect(run.output).toContain("Password rejected");
    expect(run.output).not.toContain(weak);
  });

  it("through the CLI: refuses a password given as an argument and does not echo it", () => {
    const secret = strongPassword();
    const run = cli([
      "set-password",
      "--email",
      newEmail(),
      `--password=${secret}`,
    ]);
    expect(run.status).toBe(1);
    expect(run.output).not.toContain(secret);
  });

  it("through the CLI: refuses to prompt without a terminal", () => {
    const run = cli(["set-password", "--email", newEmail()], "");
    expect(run.status).toBe(1);
    expect(run.output).toMatch(/--password-stdin/);
  });
});

describe("complete (email/password)", () => {
  it("refuses until a password is set, and refuses unknown users", async () => {
    const email = newEmail();
    await prepare({ ...ctx(), email });
    await expect(complete({ ...ctx(), email })).rejects.toThrow(
      /no password is set yet/,
    );
    await expect(complete({ ...ctx(), email: newEmail() })).rejects.toThrow(
      /No Supabase user/,
    );
    expect(await ownerCount()).toBe(0);
  });

  it("refuses an unconfirmed email", async () => {
    const email = newEmail();
    const { data } = await adminAuth.createUser({
      email,
      password: strongPassword(),
      email_confirm: false,
    });
    expect(data.user).not.toBeNull();
    await expect(complete({ ...ctx(), email })).rejects.toThrow(
      /not confirmed/,
    );
    expect(await mapping(data.user!.id)).toBeNull();
  });

  it("approves the account and maps a new owner; re-running is stable", async () => {
    const owner = await passwordOwner();
    expect(await mapping(owner.userId)).toBe(owner.ownerId);
    expect(
      (await userByEmail(owner.email))!.app_metadata[
        APPROVED_PASSWORD_EMAIL_KEY
      ],
    ).toBe(owner.email);
    const again = await complete({ ...ctx(), email: owner.email });
    expect(again).toMatchObject({ ownerId: owner.ownerId, created: false });
    expect(await ownerCount()).toBe(1);
  });

  it("enforces the single-owner rule and withdraws the approval when mapping fails", async () => {
    await passwordOwner();
    const secondEmail = newEmail();
    await expect(prepare({ ...ctx(), email: secondEmail })).rejects.toThrow(
      /An owner already exists/,
    );
    const { userId: secondId } = await prepare({
      ...ctx(),
      email: secondEmail,
      purpose: "relink",
    });
    await setPassword({
      ...authCtx(),
      email: secondEmail,
      password: strongPassword(),
    });
    await expect(complete({ ...ctx(), email: secondEmail })).rejects.toThrow(
      /An owner already exists/,
    );
    expect(await mapping(secondId)).toBeNull();
    expect(
      (await userByEmail(secondEmail))!.app_metadata[
        APPROVED_PASSWORD_EMAIL_KEY
      ],
    ).toBeUndefined();
    expect(await ownerCount()).toBe(1);
  });

  it("moves a Google-provisioned owner to email/password without changing the owner id", async () => {
    const email = newEmail();
    const { userId } = await prepare({ ...ctx(), email });
    await linkSimulatedGoogleIdentity(authDb, { id: userId, email });
    const google = await complete({ ...ctx(), email, method: "google" });
    ownerIds.push(google.ownerId);
    await setPassword({ ...authCtx(), email, password: strongPassword() });
    const password = await complete({ ...ctx(), email });
    expect(password).toMatchObject({ ownerId: google.ownerId, created: false });
    expect(await ownerCount()).toBe(1);
  });
});

describe("complete (deferred Google method)", () => {
  it("refuses until a Google identity is linked", async () => {
    const email = newEmail();
    await prepare({ ...ctx(), email });
    await expect(
      complete({ ...ctx(), email, method: "google" }),
    ).rejects.toThrow(/no Google identity is linked yet/);
  });

  it.each([
    ["an unverified Google email", { emailVerified: false }, /not verified/],
    [
      "a Google identity for a different email",
      { email: "someone-else@finora.test" },
      /does not match/,
    ],
  ])("refuses %s", async (_label, options, error) => {
    const email = newEmail();
    const { userId } = await prepare({ ...ctx(), email });
    await linkSimulatedGoogleIdentity(authDb, { id: userId, email }, options);
    await expect(
      complete({ ...ctx(), email, method: "google" }),
    ).rejects.toThrow(error);
    expect(await mapping(userId)).toBeNull();
  });

  it("approves the sole Google identity", async () => {
    const email = newEmail();
    const { userId } = await prepare({ ...ctx(), email });
    const googleId = await linkSimulatedGoogleIdentity(authDb, {
      id: userId,
      email,
    });
    const result = await complete({ ...ctx(), email, method: "google" });
    ownerIds.push(result.ownerId);
    expect(
      (await userByEmail(email))!.app_metadata[APPROVED_GOOGLE_ID_KEY],
    ).toBe(googleId);
  });
});

describe("relink", () => {
  it("moves the owner to a new account, keeping the owner id and its ledger data", async () => {
    const old = await passwordOwner();
    await db.query(
      "INSERT INTO finora.ledger_accounts (owner_id, name, kind, currency_code) VALUES ($1, 'Cash', 'asset', 'INR')",
      [old.ownerId],
    );

    const newAddress = newEmail();
    const { userId: newId } = await prepare({
      ...ctx(),
      email: newAddress,
      purpose: "relink",
    });
    await expect(relink({ ...ctx(), email: newAddress })).rejects.toThrow(
      /no password is set yet/,
    );
    await setPassword({
      ...authCtx(),
      email: newAddress,
      password: strongPassword(),
    });

    const result = await relink({ ...ctx(), email: newAddress });
    expect(result).toMatchObject({
      ownerId: old.ownerId,
      previousUserId: old.userId,
      previousApprovalCleared: true,
    });
    expect(await mapping(newId)).toBe(old.ownerId);
    expect(await mapping(old.userId)).toBeNull();
    expect(
      (await userByEmail(old.email))!.app_metadata[APPROVED_PASSWORD_EMAIL_KEY],
    ).toBeUndefined();
    const { rows } = await db.query(
      "SELECT count(*)::int AS n FROM finora.ledger_accounts WHERE owner_id = $1",
      [old.ownerId],
    );
    expect(rows[0].n).toBe(1);
    expect(await ownerCount()).toBe(1);
  });

  it("refuses to relink to a user that is already an owner", async () => {
    const owner = await passwordOwner();
    await expect(relink({ ...ctx(), email: owner.email })).rejects.toThrow(
      /already mapped/,
    );
  });
});

describe("cancel", () => {
  it("deletes a prepared, unmapped user but never a mapped one", async () => {
    const email = newEmail();
    await prepare({ ...ctx(), email });
    await cancel({ ...ctx(), email });
    expect(await userByEmail(email)).toBeNull();

    const owner = await passwordOwner();
    await expect(cancel({ ...ctx(), email: owner.email })).rejects.toThrow(
      /refusing to delete/,
    );
    expect(await userByEmail(owner.email)).not.toBeNull();
  });
});

describe("soleGoogleIdentity", () => {
  it("ignores the non-interactive email identity and rejects other providers", () => {
    const google = {
      provider: "google",
      id: randomGoogleId(),
      identity_data: { email: "a@b.co", email_verified: true },
    };
    expect(
      soleGoogleIdentity({
        email: "a@b.co",
        identities: [{ provider: "email" }, google],
      }).identity,
    ).toBe(google);
    expect(
      soleGoogleIdentity({
        email: "a@b.co",
        identities: [{ provider: "github", identity_data: {} }],
      }).reason,
    ).toMatch(/github, not google/);
  });
});
