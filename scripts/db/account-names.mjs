#!/usr/bin/env node
// Read-only account-name checks (ADR 0007). Never prints names or keys.
//
//   npm run db:account-names -- conflicts [--local]
//       Before migration 20261025000500 (or any time): lists the account ids
//       that would make it refuse to run, computed with the application's
//       own canonicalisation.
//   npm run db:account-names -- verify [--local]
//       After it: checks every stored name and name_key is exactly what the
//       application computes on this Node, and keys are unique per owner.
//       Characters newer than the server's Unicode are fine here (the
//       application, not PostgreSQL, computes names and keys).
//
// Runs in a READ ONLY transaction that is rolled back. Exits 1 on any
// problem. Run it on the pinned Node (.nvmrc). Hosted: supply
// MIGRATION_DATABASE_URL in the shell for this one command.
import { parseArgs } from "node:util";

import pg from "pg";

import { analyseAccountNames, blockingProblems, formatReport } from "../lib/account-names.mjs";
import { readLocalSupabase } from "../lib/local-supabase.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { local: { type: "boolean", default: false } },
});
const USAGE = "Usage: npm run db:account-names -- <conflicts|verify> [--local]";
/** server_version_num of PostgreSQL 17.0. */
const MIN_SERVER_VERSION_NUM = 170000;

function databaseUrl() {
  const url = values.local ? readLocalSupabase().migrationDatabaseUrl : process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error("Set MIGRATION_DATABASE_URL in the shell, or pass --local.");
  return url.replace(/\?.*$/, "");
}

async function main() {
  const [command] = positionals;
  if (command !== "conflicts" && command !== "verify") throw new Error(USAGE);
  const db = new pg.Client({ connectionString: databaseUrl() });
  await db.connect();
  try {
    await db.query("BEGIN READ ONLY");
    await db.query("SET LOCAL statement_timeout = '60s'");
    // unicode_version() and unicode_assigned() are PostgreSQL 17+, as is the
    // migration itself; check before calling either.
    const { rows: version } = await db.query("SELECT current_setting('server_version_num')::int AS num, current_setting('server_version') AS text");
    if (version[0].num < MIN_SERVER_VERSION_NUM) {
      throw new Error(`PostgreSQL ${version[0].text} is not supported: account-name keys need PostgreSQL 17 or later. Upgrade the server first; nothing was changed.`);
    }
    const { rows: meta } = await db.query(
      `SELECT unicode_version() AS unicode,
              EXISTS (SELECT 1 FROM pg_attribute
                       WHERE attrelid = 'finora.financial_accounts'::regclass AND attname = 'name_key' AND NOT attisdropped) AS has_key`,
    );
    const storedKeys = meta[0].has_key === true;
    if (command === "verify" && !storedKeys) throw new Error("finora.financial_accounts has no name_key column; run migrations first.");
    const mode = command === "verify" ? "verify" : "preflight";
    const { rows } = await db.query(
      `SELECT id::text AS id, owner_id::text AS "ownerId", name, unicode_assigned(name) AS assigned
              ${mode === "verify" ? ', name_key AS "nameKey"' : ""}
         FROM finora.financial_accounts`,
    );
    await db.query("ROLLBACK");

    console.log(`Node ${process.version} (Unicode ${process.versions.unicode}); PostgreSQL Unicode ${meta[0].unicode}`);
    const analysis = analyseAccountNames(rows, { mode });
    console.log(formatReport(analysis));
    const problems = blockingProblems(analysis);
    if (problems.length > 0) {
      const action =
        mode === "verify"
          ? "Nothing was changed. Do not edit names or keys by hand: see ADR 0007 (\"Changing Node\") and docs/runbooks/hosted-setup.md."
          : "Rename the listed accounts; nothing was changed.";
      console.error(`Problems: ${problems.join("; ")}. ${action}`);
      process.exitCode = 1;
    } else {
      console.log("OK: no problems found.");
    }
  } finally {
    await db.end();
  }
}

try {
  await main();
} catch (error) {
  // pg errors can echo connection details; print only the message.
  console.error(`Account-name check failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exit(1);
}
