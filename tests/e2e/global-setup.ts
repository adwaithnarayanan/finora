import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import { readLocalSupabase } from "../../scripts/lib/local-supabase.mjs";
import { APPROVED_PASSWORD_EMAIL_KEY } from "../../scripts/lib/provisioning.mjs";

import { type E2EUsers, USERS_FILE } from "./support/fixtures";
import { provisionOwner } from "./support/owners";

export default async function globalSetup() {
  const local = readLocalSupabase();
  const admin = createClient(local.apiUrl, local.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }).auth.admin;
  const db = new pg.Client({
    connectionString: local.migrationDatabaseUrl.replace(/\?.*$/, ""),
  });
  await db.connect();
  const email = (label: string) =>
    `e2e-${label}-${randomUUID().slice(0, 8)}@finora.test`;
  const password = () => `E2e-${randomUUID()}-Aa1`;
  const ctx = { admin, db };

  const owner = (label: string) => provisionOwner(ctx, label);

  async function plainUser(label: string, confirmed = true) {
    const user = { email: email(label), password: password() };
    const { data, error } = await admin.createUser({
      ...user,
      email_confirm: confirmed,
    });
    if (error || !data.user)
      throw new Error(`could not create ${label}: ${error?.code}`);
    return { ...user, userId: data.user.id };
  }

  try {
    const inactive = await owner("inactive");
    await db.query(
      "UPDATE finora.owners SET disabled_at = now() WHERE id = $1",
      [inactive.ownerId],
    );
    const unmapped = await plainUser("unmapped");
    await admin.updateUserById(unmapped.userId, {
      app_metadata: { [APPROVED_PASSWORD_EMAIL_KEY]: unmapped.email },
    });

    const users: E2EUsers = {
      owner: await owner("owner"),
      inactive,
      stranger: await plainUser("stranger"),
      unmapped,
      unverified: await plainUser("unverified", false),
    };
    mkdirSync(path.dirname(USERS_FILE), { recursive: true });
    writeFileSync(USERS_FILE, JSON.stringify(users), { mode: 0o600 });
  } finally {
    await db.end();
  }
}
