#!/usr/bin/env node
import { parseArgs } from "node:util";

import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import { readLocalSupabase } from "../lib/local-supabase.mjs";
import {
  ProvisioningError,
  cancel,
  complete,
  normaliseEmail,
  passwordProblem,
  prepare,
  relink,
  setPassword,
} from "../lib/provisioning.mjs";
import { promptHidden, readStdinSecret } from "../lib/read-secret.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    email: { type: "string" },
    local: { type: "boolean", default: false },
    relink: { type: "boolean", default: false },
    "password-stdin": { type: "boolean", default: false },
    "allow-additional": { type: "boolean", default: false },
  },
});

const COMMANDS = ["prepare", "set-password", "complete", "relink", "cancel"];
const USAGE = `Usage: npm run owner:provision -- <${COMMANDS.join("|")}> --email you@example.com [--local]`;

async function readPassword() {
  if (values["password-stdin"]) return readStdinSecret();
  const first = await promptHidden("New password (not shown): ");
  const problem = passwordProblem(first);
  if (problem) throw new ProvisioningError(`Password rejected: ${problem}.`);
  const second = await promptHidden("Repeat the password: ");
  if (first !== second)
    throw new ProvisioningError(
      "The passwords did not match; nothing was changed.",
    );
  return first;
}

function config() {
  if (values.local) {
    const local = readLocalSupabase();
    return {
      supabaseUrl: local.apiUrl,
      secretKey: local.secretKey,
      databaseUrl: local.migrationDatabaseUrl.replace(/\?.*$/, ""),
    };
  }
  const missing = [
    "SUPABASE_URL",
    "SUPABASE_SECRET_KEY",
    "MIGRATION_DATABASE_URL",
  ].filter((name) => !process.env[name]);
  if (missing.length > 0)
    throw new ProvisioningError(
      `Missing environment variables: ${missing.join(", ")}`,
    );
  return {
    supabaseUrl: process.env.SUPABASE_URL,
    secretKey: process.env.SUPABASE_SECRET_KEY,
    databaseUrl: process.env.MIGRATION_DATABASE_URL,
  };
}

async function main() {
  const [command] = positionals;
  if (!COMMANDS.includes(command)) throw new ProvisioningError(USAGE);
  const email = normaliseEmail(values.email);
  const allowAdditional = values["allow-additional"];

  const cfg = config();
  const admin = createClient(cfg.supabaseUrl, cfg.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }).auth.admin;
  const db = new pg.Client({ connectionString: cfg.databaseUrl });
  await db.connect();
  try {
    switch (command) {
      case "prepare": {
        const purpose = values.relink
          ? "relink"
          : allowAdditional
            ? "additional-owner"
            : "new-owner";
        const { created } = await prepare({ admin, db, email, purpose });
        console.log(
          created
            ? "Prepared a passwordless user for that email."
            : "A user with that email already exists (unmapped).",
        );
        const flag = values.local ? " --local" : "";
        console.log(
          `Next: npm run owner:provision -- set-password --email ${email}${flag}`,
        );
        console.log(
          `then: npm run owner:provision -- ${values.relink ? "relink" : "complete"} --email ${email}${flag}`,
        );
        break;
      }
      case "set-password": {
        const password = await readPassword();
        const { remainingSessions } = await setPassword({
          admin,
          db,
          email,
          password,
        });
        console.log(
          "Password set. All existing sessions for that user have ended.",
        );
        if (remainingSessions > 0)
          console.log(
            `Warning: ${remainingSessions} session(s) could not be removed.`,
          );
        break;
      }
      case "complete": {
        const { ownerId, created, approved } = await complete({
          admin,
          db,
          email,
          allowAdditional,
        });
        console.log(`Approved ${approved}.`);
        console.log(
          created
            ? `Owner created: ${ownerId}`
            : `Already provisioned: ${ownerId}`,
        );
        console.log("The owner can now sign in.");
        break;
      }
      case "relink": {
        const { ownerId, previousApprovalCleared, approved } = await relink({
          admin,
          db,
          email,
        });
        console.log(
          `Owner ${ownerId} now uses ${approved}; its data is unchanged.`,
        );
        console.log("The previous user no longer has access.");
        if (!previousApprovalCleared)
          console.log(
            "Warning: could not clear the previous user's approval; it is unmapped, so it still has no access. Delete it in the Supabase dashboard.",
          );
        break;
      }
      case "cancel": {
        await cancel({ admin, db, email });
        console.log("Deleted the prepared user.");
        break;
      }
    }
  } finally {
    await db.end();
  }
}

try {
  await main();
} catch (error) {
  const message =
    error instanceof ProvisioningError || error instanceof Error
      ? error.message
      : "unknown error";
  console.error(`Provisioning failed: ${message}`);
  process.exit(1);
}
