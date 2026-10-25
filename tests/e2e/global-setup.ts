import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import { readLocalSupabase } from "../../scripts/lib/local-supabase.mjs";
import { linkOwner } from "../../scripts/lib/owners.mjs";

import { type E2EUsers, USERS_FILE } from "./support/fixtures";

/** Creates a verified owner and a verified non-owner in the LOCAL stack. */
export default async function globalSetup() {
  const local = readLocalSupabase();
  const admin = createClient(local.apiUrl, local.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }).auth.admin;

  const password = () => `E2e-${randomUUID()}-Aa1`;
  const create = async (label: string) => {
    const email = `e2e-${label}-${randomUUID().slice(0, 8)}@finora.test`;
    const pw = password();
    const { data, error } = await admin.createUser({ email, password: pw, email_confirm: true });
    if (error || !data.user) throw new Error(`could not create ${label}: ${error?.code}`);
    return { email, password: pw, userId: data.user.id };
  };

  const owner = await create("owner");
  const stranger = await create("stranger");

  const db = new pg.Client({ connectionString: local.migrationDatabaseUrl.replace(/\?.*$/, "") });
  await db.connect();
  try {
    const { ownerId } = await linkOwner(db, { subject: owner.userId, allowAdditional: true });
    const users: E2EUsers = { owner: { ...owner, ownerId }, stranger };
    mkdirSync(path.dirname(USERS_FILE), { recursive: true });
    writeFileSync(USERS_FILE, JSON.stringify(users), { mode: 0o600 });
  } finally {
    await db.end();
  }
}
