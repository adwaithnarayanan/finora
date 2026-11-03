import type pg from "pg";

export async function lines(db: pg.Client, entryId: string) {
  const { rows } = await db.query(
    `SELECT la.kind::text AS kind, l.side::text AS side, l.amount_minor::text AS amount, la.currency_code AS currency
       FROM finora.journal_lines l JOIN finora.ledger_accounts la ON la.id = l.account_id
      WHERE l.entry_id = $1 ORDER BY l.line_no`,
    [entryId],
  );
  return rows.map((r) => [r.kind, r.side, r.amount, r.currency]);
}

export async function entryAccounts(db: pg.Client, entryId: string) {
  const { rows } = await db.query(
    `SELECT l.account_id::text AS account, l.side::text AS side, l.amount_minor::text AS amount
       FROM finora.journal_lines l WHERE l.entry_id = $1 ORDER BY l.line_no`,
    [entryId],
  );
  return rows.map((r) => [r.account, r.side, r.amount]);
}

export async function counts(db: pg.Client, ownerId: string) {
  const { rows } = await db.query(
    `SELECT (SELECT count(*) FROM finora.transactions WHERE owner_id = $1)::int AS transactions,
            (SELECT count(*) FROM finora.journal_entries WHERE owner_id = $1)::int AS entries,
            (SELECT count(*) FROM finora.journal_lines WHERE owner_id = $1)::int AS lines`,
    [ownerId],
  );
  return rows[0] as { transactions: number; entries: number; lines: number };
}

export async function dataSnapshot(db: pg.Client) {
  const tables: [string, string][] = [
    ["financial_accounts", "id"],
    ["categories", "id"],
    ["ledger_accounts", "id"],
    ["journal_entries", "id"],
    ["journal_lines", "id"],
    ["transactions", "id"],
    ["system_ledger_accounts", "ledger_account_id"],
    ["category_ledger_accounts", "ledger_account_id"],
  ];
  const out: Record<string, unknown[]> = {};
  for (const [table, order] of tables)
    out[table] = (
      await db.query(`SELECT * FROM finora.${table} ORDER BY ${order}`)
    ).rows;
  return out;
}

export async function functionCatalog(db: pg.Client) {
  const { rows } = await db.query(
    `SELECT p.proname, p.prosecdef, p.provolatile, coalesce(array_to_string(p.proconfig, ','), '') AS config,
            pg_get_userbyid(p.proowner) AS owner, coalesce(p.proacl::text, '') AS acl, md5(pg_get_functiondef(p.oid)) AS body
       FROM pg_proc p WHERE p.pronamespace = 'finora'::regnamespace ORDER BY p.proname, p.oid`,
  );
  return rows as { proname: string; body: string }[];
}

export async function triggerCatalog(db: pg.Client) {
  const { rows } = await db.query(
    `SELECT t.tgrelid::regclass::text AS tbl, t.tgname, t.tgfoid::regproc::text AS fn, t.tgenabled, t.tgtype,
            t.tgdeferrable, t.tginitdeferred
       FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE c.relnamespace = 'finora'::regnamespace AND NOT t.tgisinternal ORDER BY 1, 2`,
  );
  return rows;
}

export async function constraintCatalog(db: pg.Client) {
  const { rows } = await db.query(
    `SELECT con.conname, con.contype::text AS contype, con.convalidated, pg_get_constraintdef(con.oid) AS def
       FROM pg_constraint con WHERE con.conrelid = 'finora.transactions'::regclass ORDER BY con.conname`,
  );
  return rows as {
    conname: string;
    contype: string;
    convalidated: boolean;
    def: string;
  }[];
}

export async function migrationRows(db: pg.Client, name: string) {
  const { rows } = await db.query(
    `SELECT finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back
       FROM finora._prisma_migrations WHERE migration_name = $1 ORDER BY started_at`,
    [name],
  );
  return rows;
}
