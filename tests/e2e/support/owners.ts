import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import { readLocalSupabase } from "../../../scripts/lib/local-supabase.mjs";
import { unlinkOwners } from "../../../scripts/lib/owners.mjs";
import {
  cancel,
  complete,
  prepare,
  setPassword,
} from "../../../scripts/lib/provisioning.mjs";

import { purgeOwnerData } from "../../support/purge";

import { EXTRA_OWNERS_FILE, type ProvisionedOwner } from "./fixtures";

type Context = {
  admin: ReturnType<typeof createClient>["auth"]["admin"];
  db: pg.Client;
};

const email = (label: string) =>
  `e2e-${label}-${randomUUID().slice(0, 8)}@finora.test`;
const password = () => `E2e-${randomUUID()}-Aa1`;

async function withLocal<T>(fn: (ctx: Context) => Promise<T>): Promise<T> {
  const local = readLocalSupabase();
  const admin = createClient(local.apiUrl, local.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }).auth.admin;
  const db = new pg.Client({
    connectionString: local.migrationDatabaseUrl.replace(/\?.*$/, ""),
  });
  await db.connect();
  try {
    return await fn({ admin, db });
  } finally {
    await db.end();
  }
}

export async function provisionOwner(
  ctx: Context,
  label: string,
): Promise<ProvisionedOwner> {
  const user = { email: email(label), password: password() };
  const { userId } = await prepare({
    ...ctx,
    email: user.email,
    purpose: "additional-owner",
  });
  try {
    await setPassword({ ...ctx, email: user.email, password: user.password });
    const { ownerId } = await complete({
      ...ctx,
      email: user.email,
      allowAdditional: true,
    });
    return { ...user, userId, ownerId: ownerId as string };
  } catch (error) {
    await cancel({ ...ctx, email: user.email }).catch(() => {});
    throw error;
  }
}

export async function provisionTestOwner(
  label: string,
): Promise<ProvisionedOwner> {
  return withLocal(async (ctx) => {
    const owner = await provisionOwner(ctx, label);
    mkdirSync(path.dirname(EXTRA_OWNERS_FILE), { recursive: true });
    appendFileSync(EXTRA_OWNERS_FILE, `${JSON.stringify(owner)}\n`, {
      mode: 0o600,
    });
    return owner;
  });
}

export async function removeTestUsers(
  users: readonly { userId: string; ownerId?: string }[],
): Promise<void> {
  if (users.length === 0) return;
  await withLocal(async ({ admin, db }) => {
    const ownerIds = users.flatMap((u) => (u.ownerId ? [u.ownerId] : []));
    await purgeOwnerData(db, ownerIds);
    await unlinkOwners(db, ownerIds);
    const failures: string[] = [];
    for (const { userId } of users) {
      const { error } = await admin.deleteUser(userId);
      if (error && error.code !== "user_not_found")
        failures.push(`${userId}: ${error.code ?? error.status}`);
    }
    if (failures.length > 0)
      throw new Error(`could not delete test users: ${failures.join(", ")}`);
  });
}
