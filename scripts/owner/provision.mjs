#!/usr/bin/env node
// Provision Finora's owner: invite the user through Supabase Auth (they verify
// their email and set a password from the invite link) and map the resulting
// auth user to a new internal owner.
//
//   Local:  npm run owner:provision -- --local --email you@example.com
//   Hosted: SUPABASE_URL=… SUPABASE_SECRET_KEY=… MIGRATION_DATABASE_URL=… \
//           NEXT_PUBLIC_SITE_URL=https://… npm run owner:provision -- --email you@example.com
//
// Options:
//   --existing          map an already-registered, email-verified auth user instead of inviting
//   --allow-additional  permit a second owner (Finora is single-owner by default)
//
// No secret or connection string is ever printed.
import { parseArgs } from "node:util";

import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import { readLocalSupabase } from "../lib/local-supabase.mjs";
import { linkOwner } from "../lib/owners.mjs";

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    local: { type: "boolean", default: false },
    existing: { type: "boolean", default: false },
    "allow-additional": { type: "boolean", default: false },
  },
});

const email = values.email?.trim().toLowerCase();
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error("Usage: npm run owner:provision -- [--local] [--existing] --email you@example.com");
  process.exit(1);
}

function config() {
  if (values.local) {
    const local = readLocalSupabase();
    return {
      supabaseUrl: local.apiUrl,
      secretKey: local.secretKey,
      databaseUrl: local.migrationDatabaseUrl.replace(/\?.*$/, ""),
      siteUrl: "http://localhost:3000",
    };
  }
  const missing = ["SUPABASE_URL", "SUPABASE_SECRET_KEY", "MIGRATION_DATABASE_URL", "NEXT_PUBLIC_SITE_URL"].filter(
    (name) => !process.env[name],
  );
  if (missing.length > 0) {
    console.error(`Missing environment variables: ${missing.join(", ")}`);
    process.exit(1);
  }
  return {
    supabaseUrl: process.env.SUPABASE_URL,
    secretKey: process.env.SUPABASE_SECRET_KEY,
    databaseUrl: process.env.MIGRATION_DATABASE_URL,
    siteUrl: process.env.NEXT_PUBLIC_SITE_URL,
  };
}

async function findUserByEmail(admin, address) {
  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`Could not list users (${error.code ?? error.status})`);
    const match = data.users.find((user) => user.email?.toLowerCase() === address);
    if (match) return match;
    if (data.users.length < 200) return null;
  }
  return null;
}

async function main() {
  const cfg = config();
  const admin = createClient(cfg.supabaseUrl, cfg.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }).auth.admin;

  const client = new pg.Client({ connectionString: cfg.databaseUrl });
  await client.connect();
  try {
    // Check the single-owner rule before touching Supabase Auth, so a refused
    // run never leaves an invited-but-unmapped user behind. linkOwner()
    // re-checks under a lock.
    if (!values["allow-additional"]) {
      const { rows } = await client.query("SELECT count(*)::int AS n FROM finora.owners");
      if (rows[0].n > 0) {
        throw new Error("An owner already exists. Pass --allow-additional to add another deliberately.");
      }
    }

    let userId;
    let invited = false;
    if (values.existing) {
      const user = await findUserByEmail(admin, email);
      if (!user) throw new Error("No auth user with that email.");
      if (!user.email_confirmed_at) throw new Error("That user has not verified their email yet.");
      userId = user.id;
    } else {
      const { data, error } = await admin.inviteUserByEmail(email, {
        redirectTo: new URL("/auth/confirm", cfg.siteUrl).toString(),
      });
      if (error) throw new Error(`Invite failed (${error.code ?? error.status}). Use --existing for registered users.`);
      userId = data.user.id;
      invited = true;
    }

    try {
      const { ownerId, created } = await linkOwner(client, {
        subject: userId,
        allowAdditional: values["allow-additional"],
      });
      console.log(created ? `Owner created: ${ownerId}` : `Already provisioned: ${ownerId}`);
      if (invited) console.log("Invite sent. The owner verifies their email and sets a password from the link.");
    } catch (error) {
      if (invited) await admin.deleteUser(userId); // undo the invite we just created
      throw error;
    }
  } finally {
    await client.end();
  }
}

try {
  await main();
} catch (error) {
  console.error(`Provisioning failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exit(1);
}
