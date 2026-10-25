import { randomUUID } from "node:crypto";

import pg from "pg";
import { inject } from "vitest";

import { createPrismaClient } from "@/server/db/client";

/** Privileged connection (postgres, BYPASSRLS) for fixtures and catalog checks only. */
export async function adminClient(): Promise<pg.Client> {
  const url = new URL(inject("local").migrationDatabaseUrl);
  url.search = "";
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  return client;
}

/** Raw connection as the runtime role, exactly as the app connects. */
export async function appClient(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: inject("local").appDatabaseUrl });
  await client.connect();
  return client;
}

/** The app's Prisma client, connected as finora_app with a single connection. */
export function appPrisma() {
  return createPrismaClient(inject("local").appDatabaseUrl, 1);
}

export const TEST_PROVIDER = "itest";

export type SeededOwner = { ownerId: string; subject: string };

export async function seedOwner(
  admin: pg.Client,
  options: { disabled?: boolean; provider?: string } = {},
): Promise<SeededOwner> {
  const subject = `itest-${randomUUID()}`;
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO finora.owners (disabled_at) VALUES (CASE WHEN $1 THEN now() END) RETURNING id`,
    [options.disabled === true],
  );
  const ownerId = rows[0]!.id;
  await admin.query(
    `INSERT INTO finora.owner_identities (owner_id, provider, subject) VALUES ($1, $2, $3)`,
    [ownerId, options.provider ?? TEST_PROVIDER, subject],
  );
  return { ownerId, subject };
}

/**
 * Removes test owners' ledger rows. Posted history is immutable even for the
 * migration role, so this LOCAL-ONLY cleanup disables triggers for one
 * transaction (session_replication_role = replica, which Supabase grants to
 * `postgres`). Nothing in the schema offers a bypass; never run this against
 * a hosted database.
 */
export async function purgeLedger(admin: pg.Client, ownerIds: string[]): Promise<void> {
  if (ownerIds.length === 0) return;
  await admin.query("BEGIN");
  try {
    await admin.query("SET LOCAL session_replication_role = replica");
    for (const table of ["journal_lines", "journal_entries", "ledger_accounts"]) {
      await admin.query(`DELETE FROM finora.${table} WHERE owner_id = ANY($1::uuid[])`, [ownerIds]);
    }
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
}

export async function deleteOwners(admin: pg.Client, ownerIds: string[]): Promise<void> {
  if (ownerIds.length === 0) return;
  await purgeLedger(admin, ownerIds);
  await admin.query(`DELETE FROM finora.owner_identities WHERE owner_id = ANY($1::uuid[])`, [ownerIds]);
  await admin.query(`DELETE FROM finora.owners WHERE id = ANY($1::uuid[])`, [ownerIds]);
}
