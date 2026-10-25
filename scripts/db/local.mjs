#!/usr/bin/env node
// Local database workflow. Every command targets the local Supabase stack
// only (connection details come from `supabase status`, never from .env files).
//
//   node scripts/db/local.mjs setup        apply migrations + enable finora_app login
//   node scripts/db/local.mjs status       show migration status
//   node scripts/db/local.mjs new <name>   create a new migration (not applied)
//   node scripts/db/local.mjs drift        fail if migrations and schema.prisma disagree
//   node scripts/db/local.mjs reset        DESTROYS local data, then setup
import { execFileSync } from "node:child_process";
import path from "node:path";
import pg from "pg";

import { LOCAL_APP_DB_PASSWORD, readLocalSupabase } from "../lib/local-supabase.mjs";

const root = process.cwd();
const bin = (name) => path.join(root, "node_modules", ".bin", name);

const SHADOW_DATABASE = "finora_shadow";

function shadowUrl(local) {
  const url = new URL(local.migrationDatabaseUrl);
  url.pathname = `/${SHADOW_DATABASE}`;
  return url.toString();
}

function prisma(args, local, extraEnv = {}) {
  execFileSync(bin("prisma"), args, {
    stdio: "inherit",
    env: { ...process.env, MIGRATION_DATABASE_URL: local.migrationDatabaseUrl, ...extraEnv },
  });
}

async function adminQuery(local, sql) {
  const client = new pg.Client({ connectionString: local.migrationDatabaseUrl.replace(/\?.*$/, "") });
  await client.connect();
  try {
    return await client.query(sql);
  } finally {
    await client.end();
  }
}

/** Recreates the throwaway shadow database used only for drift detection. */
async function resetShadowDatabase(local) {
  await adminQuery(local, `DROP DATABASE IF EXISTS ${SHADOW_DATABASE} WITH (FORCE)`);
  await adminQuery(local, `CREATE DATABASE ${SHADOW_DATABASE}`);
}

async function enableAppLogin(local) {
  const client = new pg.Client({ connectionString: local.migrationDatabaseUrl.replace(/\?.*$/, "") });
  await client.connect();
  try {
    // Literal is a local-only constant; quote_literal guards the statement anyway.
    const { rows } = await client.query("SELECT quote_literal($1) AS pw", [LOCAL_APP_DB_PASSWORD]);
    await client.query(`ALTER ROLE finora_app WITH LOGIN PASSWORD ${rows[0].pw}`);
  } finally {
    await client.end();
  }
  console.log("finora_app login enabled for the local stack.");
}

async function setup(local) {
  prisma(["migrate", "deploy"], local);
  await enableAppLogin(local);
}

const [command, ...rest] = process.argv.slice(2);
const local = readLocalSupabase(root);

switch (command) {
  case "setup":
    await setup(local);
    break;
  case "status":
    prisma(["migrate", "status"], local);
    break;
  case "new": {
    const name = rest[0];
    if (!name || !/^[a-z0-9_]+$/.test(name)) {
      console.error("Usage: npm run db:local:new -- <snake_case_name>");
      process.exit(1);
    }
    prisma(["migrate", "dev", "--create-only", "--name", name], local);
    break;
  }
  case "drift":
    await resetShadowDatabase(local);
    try {
      prisma(
        ["migrate", "diff", "--from-migrations", "prisma/migrations", "--to-schema", "prisma/schema.prisma", "--exit-code"],
        local,
        { SHADOW_DATABASE_URL: shadowUrl(local) },
      );
      console.log("No drift: migrations match prisma/schema.prisma.");
    } finally {
      await adminQuery(local, `DROP DATABASE IF EXISTS ${SHADOW_DATABASE} WITH (FORCE)`);
    }
    break;
  case "reset":
    if (!rest.includes("--yes")) {
      console.error("This deletes ALL data in the LOCAL Supabase database. Re-run with --yes to confirm.");
      process.exit(1);
    }
    execFileSync(bin("supabase"), ["db", "reset", "--local"], { stdio: "inherit" });
    await setup(local);
    break;
  default:
    console.error("Usage: node scripts/db/local.mjs <setup|status|new|drift|reset>");
    process.exit(1);
}
