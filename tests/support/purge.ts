import type pg from "pg";

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

export async function purgeOwnerData(
  admin: pg.Client,
  ownerIds: readonly string[],
): Promise<void> {
  if (ownerIds.length === 0) return;
  await admin.query("BEGIN");
  try {
    await admin.query("SET LOCAL session_replication_role = replica");
    for (const table of OWNER_DATA_TABLES) {
      await admin.query(
        `DELETE FROM finora.${table} WHERE owner_id = ANY($1::uuid[])`,
        [ownerIds],
      );
    }
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
}
