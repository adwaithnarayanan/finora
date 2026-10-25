import { existsSync, rmSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import { readLocalSupabase } from "../../scripts/lib/local-supabase.mjs";
import { unlinkOwners } from "../../scripts/lib/owners.mjs";

import { purgeOwnerData } from "../support/purge";

import { EXTRA_OWNERS_FILE, type ProvisionedOwner, USERS_FILE, e2eUsers, extraOwners } from "./support/fixtures";

/**
 * Removes exactly the users this run created: global-setup's (USERS_FILE) and
 * the owners tests provisioned for themselves (EXTRA_OWNERS_FILE).
 */
export default async function globalTeardown() {
  const users = existsSync(USERS_FILE) ? Object.values(e2eUsers()) : [];
  const extras = extraOwners();
  if (users.length === 0 && extras.length === 0) return;
  const local = readLocalSupabase();

  const db = new pg.Client({ connectionString: local.migrationDatabaseUrl.replace(/\?.*$/, "") });
  await db.connect();
  try {
    // The run created accounts and posted entries for its owners; remove them first.
    const ownerIds = [...users, ...extras].filter((u): u is ProvisionedOwner => "ownerId" in u).map((u) => u.ownerId);
    await purgeOwnerData(db, ownerIds);
    await unlinkOwners(db, ownerIds);
  } finally {
    await db.end();
  }
  const admin = createClient(local.apiUrl, local.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }).auth.admin;
  for (const user of [...users, ...extras]) await admin.deleteUser(user.userId);
  rmSync(USERS_FILE, { force: true });
  rmSync(EXTRA_OWNERS_FILE, { force: true });
}
