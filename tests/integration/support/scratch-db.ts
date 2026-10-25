import { execFileSync } from "node:child_process";
import path from "node:path";

import pg from "pg";
import { inject } from "vitest";

import { adminClient } from "./db";

const PREFIX = "finora_itest_";

/**
 * A throwaway database on the LOCAL server with every migration applied, for
 * tests whose subject is a database-wide rule (e.g. the single-owner rule)
 * that must not depend on, or touch, data already in the local database.
 * Only names starting with `finora_itest_` are ever created or dropped.
 */
export async function createMigratedScratchDatabase(name: string): Promise<{ client: pg.Client; drop: () => Promise<void> }> {
  if (!new RegExp(`^${PREFIX}[a-z0-9_]+$`).test(name)) throw new Error(`scratch database names must start with ${PREFIX}`);
  const admin = await adminClient();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = new URL(inject("local").migrationDatabaseUrl); // loopback-checked by readLocalSupabase
  url.pathname = `/${name}`;
  execFileSync(path.join(process.cwd(), "node_modules", ".bin", "prisma"), ["migrate", "deploy"], {
    stdio: "ignore",
    env: { ...process.env, MIGRATION_DATABASE_URL: url.toString() },
  });
  url.search = "";
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  return {
    client,
    drop: async () => {
      await client.end();
      const cleanup = await adminClient();
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}
