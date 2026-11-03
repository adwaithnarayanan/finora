import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import type pg from "pg";
import { afterAll, describe, expect, inject, it } from "vitest";

import { createPrismaClient } from "@/server/db/client";

import { preflightHintQuery } from "../support/migration-hint";

import { runCleanup } from "./support/cleanup";
import { seedOwner } from "./support/db";
import { authorize, financeFor, ledgerFor } from "./support/ledger";
import { historyOn } from "./support/pre-migration";
import {
  type MigrationSet,
  type ScratchDatabase,
  createMigratedScratchDatabase,
  deployMigrations,
  migrationSet,
  runPrisma,
} from "./support/scratch-db";

/**
 * Migrations 20261025000600_credit_card_account_type (enum value only) and
 * 20261025000700_account_ledger_class (ADR 0008), on scratch databases that
 * this file creates and drops. Nothing here touches the local database's
 * own data.
 */

const ENUM = "20261025000600_credit_card_account_type";
const CLASS = "20261025000700_account_ledger_class";
const BEFORE_ENUM = "20261025000500_account_name_key";
const CLASS_SQL = readFileSync(path.join(process.cwd(), "prisma/migrations", CLASS, "migration.sql"), "utf8");
const today = "2026-10-25";

const scratches: ScratchDatabase[] = [];
const sets: MigrationSet[] = [];
const clients: { $disconnect: () => Promise<void> }[] = [];

afterAll(async () => {
  await runCleanup([
    ...clients.map((c) => ["disconnect a scratch Prisma client", () => c.$disconnect()] as const),
    ...scratches.map((s) => [`drop ${s.name}`, () => s.drop()] as const),
    ...sets.map((s) => ["remove a temporary migrations copy", async () => s.remove()] as const),
  ]);
});

async function scratchThrough(label: string, through: string): Promise<ScratchDatabase> {
  const set = migrationSet({ through });
  sets.push(set);
  const scratch = await createMigratedScratchDatabase(label, { migrate: (url) => deployMigrations(url, set) });
  scratches.push(scratch);
  return scratch;
}

/** The finance service as finora_app on a scratch database (the role is cluster-wide). */
function financeOn(scratch: ScratchDatabase) {
  const url = new URL(inject("local").appDatabaseUrl);
  url.pathname = `/${scratch.name}`;
  const prisma = createPrismaClient(url.toString(), 1);
  clients.push(prisma);
  return { prisma, finance: financeFor(prisma) };
}

/** Every business and ledger row, so any change by the migration shows. */
async function dataSnapshot(db: pg.Client) {
  const tables: [string, string][] = [
    ["financial_accounts", "id"],
    ["ledger_accounts", "id"],
    ["journal_entries", "id"],
    ["journal_lines", "id"],
    ["transactions", "id"],
    ["system_ledger_accounts", "ledger_account_id"],
    ["category_ledger_accounts", "ledger_account_id"],
  ];
  const out: Record<string, unknown[]> = {};
  for (const [table, order] of tables) out[table] = (await db.query(`SELECT * FROM finora.${table} ORDER BY ${order}`)).rows;
  return out;
}

async function functions(db: pg.Client) {
  const { rows } = await db.query(
    `SELECT p.proname, p.prosecdef, md5(pg_get_functiondef(p.oid)) AS body
       FROM pg_proc p WHERE p.pronamespace = 'finora'::regnamespace
        AND p.proname IN ('financial_accounts_guard', 'assert_transaction_valid', 'financial_account_ledger_kind') ORDER BY 1`,
  );
  return rows;
}

async function migrationRows(db: pg.Client, name: string) {
  const { rows } = await db.query(
    `SELECT finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back
       FROM finora._prisma_migrations WHERE migration_name = $1 ORDER BY started_at`,
    [name],
  );
  return rows;
}

/** Inserts, as the migration role, an account of `type` backed by a new ledger account of `kind`. */
async function rawAccount(db: pg.Client, ownerId: string, type: string, kind: string) {
  const ledger = await db.query<{ id: string }>(
    "INSERT INTO finora.ledger_accounts (owner_id, name, kind, currency_code) VALUES ($1, $2, $3, 'INR') RETURNING id::text",
    [ownerId, `itest:${randomUUID()}`, kind],
  );
  const name = `raw ${randomUUID()}`;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO finora.financial_accounts (owner_id, name, name_key, type, currency_code, ledger_account_id, creation_key, creation_fingerprint)
     VALUES ($1, $2, $2, $3, 'INR', $4, $5, repeat('0', 64)) RETURNING id::text`,
    [ownerId, name, type, ledger.rows[0]!.id, `itest-${randomUUID()}`],
  );
  return { accountId: rows[0]!.id, ledgerAccountId: ledger.rows[0]!.id };
}

describe("migration on existing data", () => {
  it("applies to pre-credit-card data without changing a row, and then supports liability-backed cards", async () => {
    const scratch = await scratchThrough("ledgerclass_ok", BEFORE_ENUM);
    const db = scratch.client;
    const { prisma, finance } = financeOn(scratch);
    const seeded = await seedOwner(db);
    const owner = await authorize(prisma, seeded.subject);
    await finance.initializeDefaultCategories(owner);
    const categories = await finance.listCategories(owner);
    const salary = categories.find((c) => c.name === "Salary")!;
    const groceries = categories.find((c) => c.name === "Groceries")!;
    // The accounts go through the service, but the transactions cannot: the
    // finance store reads and writes columns that later migrations add (see
    // historyOn). Opening balances, a correction, income, a voided expense
    // and a transfer, which is the shape 0700 re-checks every row against.
    const bank = (await finance.createAccount(owner, { name: "Axis", type: "bank", idempotencyKey: randomUUID() })).value;
    const cash = (await finance.createAccount(owner, { name: "Wallet", type: "cash", idempotencyKey: randomUUID() })).value;
    const history = historyOn({ db, ledger: ledgerFor(prisma), owner, ownerId: seeded.ownerId, date: today });
    const equity = await history.openingEquity();
    const salaryLedger = await history.mapCategory(salary.id, "income");
    const groceriesLedger = await history.mapCategory(groceries.id, "expense");
    await history.record({ kind: "opening_balance", amount: "50000", debit: bank.ledgerAccountId, credit: equity, destination: bank.id });
    const cashOpening = await history.record({ kind: "opening_balance", amount: "500", debit: cash.ledgerAccountId, credit: equity, destination: cash.id });
    await history.correct(cashOpening, { kind: "opening_balance", amount: "600", debit: cash.ledgerAccountId, credit: equity, destination: cash.id });
    await history.record({ kind: "income", amount: "1000", debit: bank.ledgerAccountId, credit: salaryLedger, destination: bank.id, category: salary.id });
    const spent = await history.record({ kind: "expense", amount: "250", debit: groceriesLedger, credit: bank.ledgerAccountId, source: bank.id, category: groceries.id });
    await history.void(spent);
    await history.record({ kind: "transfer", amount: "100", debit: cash.ledgerAccountId, credit: bank.ledgerAccountId, source: bank.id, destination: cash.id });
    const before = await dataSnapshot(db);

    // The real project migrations, as on a deployment, but stopping at 0700:
    // this test's subject is 0600 and 0700, and later milestones change the
    // rows and catalogs compared below.
    const upTo0700 = migrationSet({ through: CLASS });
    sets.push(upTo0700);
    deployMigrations(scratch.url, upTo0700);

    expect(await dataSnapshot(db)).toEqual(before);
    expect(await migrationRows(db, ENUM)).toEqual([{ finished: true, rolled_back: false }]);
    expect(await migrationRows(db, CLASS)).toEqual([{ finished: true, rolled_back: false }]);
    expect((await functions(db)).map((f) => [f.proname, f.prosecdef])).toEqual([
      ["assert_transaction_valid", false],
      ["financial_account_ledger_kind", false],
      ["financial_accounts_guard", true],
    ]);
    // The remaining migrations, so the application path can be exercised too
    // (this working tree's finance store needs the columns they add).
    deployMigrations(scratch.url);
    expect(await finance.getAccount(owner, bank.id).then((d) => d.balance.toDecimalString())).toBe("50900.00");

    const card = (await finance.createAccount(owner, { name: "HDFC Card", type: "credit_card", openingBalance: { amount: "12000", date: today }, idempotencyKey: randomUUID() })).value;
    const { rows } = await db.query(
      `SELECT la.kind::text AS kind, l.side::text AS side, l.amount_minor::text AS amount
         FROM finora.transactions t JOIN finora.journal_lines l ON l.entry_id = t.journal_entry_id
         JOIN finora.ledger_accounts la ON la.id = l.account_id
        WHERE t.destination_account_id = $1 ORDER BY l.line_no`,
      [card.id],
    );
    expect(rows).toEqual([
      { kind: "equity", side: "debit", amount: "1200000" },
      { kind: "liability", side: "credit", amount: "1200000" },
    ]);
    expect((await finance.getAccount(owner, card.id)).balance.toDecimalString()).toBe("12000.00");
  }, 180_000);

  it("leaves the enum value harmless until the class migration: the old guard still requires an asset", async () => {
    const scratch = await scratchThrough("ledgerclass_enum", ENUM);
    const db = scratch.client;
    const { rows } = await db.query<{ id: string }>("INSERT INTO finora.owners DEFAULT VALUES RETURNING id::text");
    await expect(rawAccount(db, rows[0]!.id, "credit_card", "liability")).rejects.toThrow(/must be backed by an asset ledger account/);
    expect((await functions(db)).map((f) => f.proname)).toEqual(["assert_transaction_valid", "financial_accounts_guard"]);
  }, 120_000);

  it("refuses inconsistent existing data, changing nothing, and applies once the operator has resolved it", async () => {
    const scratch = await scratchThrough("ledgerclass_refuse", ENUM);
    const db = scratch.client;
    const { rows } = await db.query<{ id: string }>("INSERT INTO finora.owners DEFAULT VALUES RETURNING id::text");
    const ownerId = rows[0]!.id;
    await rawAccount(db, ownerId, "bank", "asset");
    // Possible only between the two migrations (the old guard checks for an asset, not the type's class).
    const wrong = await rawAccount(db, ownerId, "credit_card", "asset");
    const before = await dataSnapshot(db);
    const fnBefore = await functions(db);

    expect(() => deployMigrations(scratch.url)).toThrow(/1 financial account\(s\) have a ledger account of the wrong class for their type/);

    expect(await dataSnapshot(db)).toEqual(before); // never reclassified or rewritten
    expect(await functions(db)).toEqual(fnBefore); // no function replaced or added
    expect(await migrationRows(db, CLASS)).toEqual([{ finished: false, rolled_back: false }]);
    expect(() => deployMigrations(scratch.url)).toThrow(/P3009|failed migrations/);

    // The query the refusal's HINT gives the operator runs after the rollback
    // (the mapping function does not exist then) and lists exactly the offending account.
    expect((await db.query("SELECT to_regproc('finora.financial_account_ledger_kind')::text AS fn")).rows[0].fn).toBeNull();
    const listed = await db.query(preflightHintQuery(CLASS_SQL));
    expect(listed.rows).toEqual([{ id: wrong.accountId, owner_id: ownerId, type: "credit_card", kind: "asset" }]);

    // Recovery (runbook): the operator decides; here the stray, history-less row is removed.
    await db.query("DELETE FROM finora.financial_accounts WHERE id = $1", [wrong.accountId]);
    runPrisma(scratch.url, ["migrate", "resolve", "--rolled-back", CLASS]);
    deployMigrations(scratch.url);
    expect((await functions(db)).map((f) => f.proname)).toContain("financial_account_ledger_kind");
  }, 120_000);

  it("gives up after lock_timeout instead of queueing behind an account write, changing nothing", async () => {
    const scratch = await scratchThrough("ledgerclass_lock", ENUM);
    const db = scratch.client;
    const fnBefore = await functions(db);
    // An open transaction holding ROW EXCLUSIVE (any account write) conflicts with SHARE ROW EXCLUSIVE.
    await db.query("BEGIN");
    await db.query("LOCK TABLE finora.financial_accounts IN ROW EXCLUSIVE MODE");
    const started = Date.now();
    try {
      expect(() => deployMigrations(scratch.url)).toThrow(/lock timeout/);
    } finally {
      await db.query("ROLLBACK");
    }
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(5_000);
    expect(waited).toBeLessThan(60_000);
    expect(await functions(db)).toEqual(fnBefore);
    runPrisma(scratch.url, ["migrate", "resolve", "--rolled-back", CLASS]);
    deployMigrations(scratch.url);
    expect(await migrationRows(db, CLASS)).toEqual([
      { finished: false, rolled_back: true },
      { finished: true, rolled_back: false },
    ]);
  }, 120_000);

  it("rolls back every statement when it fails after its last step, through prisma migrate deploy", async () => {
    const scratch = await scratchThrough("ledgerclass_late", ENUM);
    const db = scratch.client;
    const fnBefore = await functions(db);
    const failing = migrationSet({ append: { [CLASS]: "SELECT 1 / 0; -- itest: fail after every statement above" } });
    sets.push(failing);
    expect(() => deployMigrations(scratch.url, failing)).toThrow(/division by zero/);
    expect(await functions(db)).toEqual(fnBefore);
    expect(await migrationRows(db, CLASS)).toEqual([{ finished: false, rolled_back: false }]);
  }, 120_000);
});
