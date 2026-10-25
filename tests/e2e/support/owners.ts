import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import { readLocalSupabase } from "../../../scripts/lib/local-supabase.mjs";
import { cancel, complete, prepare, setPassword } from "../../../scripts/lib/provisioning.mjs";

import { EXTRA_OWNERS_FILE, type ProvisionedOwner } from "./fixtures";

type Context = { admin: ReturnType<typeof createClient>["auth"]["admin"]; db: pg.Client };

const email = (label: string) => `e2e-${label}-${randomUUID().slice(0, 8)}@finora.test`;
const password = () => `E2e-${randomUUID()}-Aa1`;

/**
 * A new LOCAL owner through the real provisioning workflow: prepare ->
 * set-password -> complete. If a later step fails, the prepared (unmapped)
 * user is removed again.
 */
export async function provisionOwner(ctx: Context, label: string): Promise<ProvisionedOwner> {
  const user = { email: email(label), password: password() };
  const { userId } = await prepare({ ...ctx, email: user.email, purpose: "additional-owner" });
  try {
    await setPassword({ ...ctx, email: user.email, password: user.password });
    const { ownerId } = await complete({ ...ctx, email: user.email, allowAdditional: true });
    return { ...user, userId, ownerId: ownerId as string };
  } catch (error) {
    await cancel({ ...ctx, email: user.email }).catch(() => {});
    throw error;
  }
}

/**
 * A brand-new owner for one test attempt (a retry gets another one), so a
 * test never depends on what earlier tests or attempts left behind. Recorded
 * in EXTRA_OWNERS_FILE; global teardown removes it with the run's users.
 */
export async function provisionTestOwner(label: string): Promise<ProvisionedOwner> {
  const local = readLocalSupabase();
  const admin = createClient(local.apiUrl, local.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }).auth.admin;
  const db = new pg.Client({ connectionString: local.migrationDatabaseUrl.replace(/\?.*$/, "") });
  await db.connect();
  try {
    const owner = await provisionOwner({ admin, db }, label);
    mkdirSync(path.dirname(EXTRA_OWNERS_FILE), { recursive: true });
    appendFileSync(EXTRA_OWNERS_FILE, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
    return owner;
  } finally {
    await db.end();
  }
}
