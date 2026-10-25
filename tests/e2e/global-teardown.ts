import { existsSync, rmSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import { readLocalSupabase } from "../../scripts/lib/local-supabase.mjs";
import { unlinkOwners } from "../../scripts/lib/owners.mjs";

import { purgeOwnerData } from "../support/purge";

import { USERS_FILE, e2eUsers } from "./support/fixtures";

export default async function globalTeardown() {
  if (!existsSync(USERS_FILE)) return;
  const users = e2eUsers();
  const local = readLocalSupabase();

  const db = new pg.Client({ connectionString: local.migrationDatabaseUrl.replace(/\?.*$/, "") });
  await db.connect();
  try {
    // The run created accounts and posted entries for the owner; remove them first.
    const ownerIds = [users.owner.ownerId, users.inactive.ownerId];
    await purgeOwnerData(db, ownerIds);
    await unlinkOwners(db, ownerIds);
  } finally {
    await db.end();
  }
  const admin = createClient(local.apiUrl, local.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }).auth.admin;
  for (const user of Object.values(users)) await admin.deleteUser(user.userId);
  rmSync(USERS_FILE);
}
