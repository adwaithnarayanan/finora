import type pg from "pg";

/** Owner-scoped tables, children before parents. */
const OWNER_DATA_TABLES = [
  "transactions",
  "category_ledger_accounts",
  "system_ledger_accounts",
  "categories",
  "financial_accounts",
  "journal_lines",
  "journal_entries",
  "ledger_accounts",
] as const;

/**
 * Removes test owners' financial and ledger rows. Posted history is immutable
 * even for the migration role, so this LOCAL-ONLY cleanup disables triggers
 * for one transaction (session_replication_role = replica, which Supabase
 * grants to `postgres`). Nothing in the schema offers a bypass; never run
 * this against a hosted database.
 */
export async function purgeOwnerData(admin: pg.Client, ownerIds: readonly string[]): Promise<void> {
  if (ownerIds.length === 0) return;
  await admin.query("BEGIN");
  try {
    await admin.query("SET LOCAL session_replication_role = replica");
    for (const table of OWNER_DATA_TABLES) {
      await admin.query(`DELETE FROM finora.${table} WHERE owner_id = ANY($1::uuid[])`, [ownerIds]);
    }
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
}
