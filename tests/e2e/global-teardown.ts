import { existsSync, rmSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import { readLocalSupabase } from "../../scripts/lib/local-supabase.mjs";
import { unlinkOwners } from "../../scripts/lib/owners.mjs";

import { USERS_FILE, e2eUsers } from "./support/fixtures";

export default async function globalTeardown() {
  if (!existsSync(USERS_FILE)) return;
  const users = e2eUsers();
  const local = readLocalSupabase();

  const db = new pg.Client({ connectionString: local.migrationDatabaseUrl.replace(/\?.*$/, "") });
  await db.connect();
  try {
    await unlinkOwners(db, [users.owner.ownerId]);
  } finally {
    await db.end();
  }
  const admin = createClient(local.apiUrl, local.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }).auth.admin;
  await admin.deleteUser(users.owner.userId);
  await admin.deleteUser(users.stranger.userId);
  rmSync(USERS_FILE);
}
