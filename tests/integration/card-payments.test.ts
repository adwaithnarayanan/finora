import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import type { AuthorizedOwner } from "@/server/auth/types";
import { createPrismaClient } from "@/server/db/client";
import { IdempotencyConflictError } from "@/server/ledger/errors";

import { runCleanup } from "./support/cleanup";
import { seedOwner } from "./support/db";
import { asOwner, authorize, financeFor, ledgerFor } from "./support/ledger";
import { historyOn } from "./support/pre-migration";
import {
  type MigrationSet,
  type ScratchDatabase,
  createMigratedScratchDatabase,
  deployMigrations,
  migrationSet,
} from "./support/scratch-db";

/**
 * Milestone 5C (ADR 0008): card payments, that is, repayments of a credit
 * card from a bank or cash account. Migrations
 * 20261026000000_card_payment_kind and 20261026000100_card_payments, and the
 * service and COMMIT-time rules they enable, on scratch databases that this
 * file creates and drops. Nothing here touches the local database's own data.
 */

const CARD_PAYMENT_KIND = "20261026000000_card_payment_kind";
const CARD_PAYMENTS = "20261026000100_card_payments";
const BEFORE = "20261025000800_card_expenses";
const today = "2026-10-25";
/** The COMMIT-time refusal for a card payment with the wrong account classes. */
const WRONG_CLASSES = /a card payment pays a credit card from a bank or cash account/;

const scratches: ScratchDatabase[] = [];
const sets: MigrationSet[] = [];
const closers: [string, () => Promise<unknown>][] = [];

afterAll(async () => {
  await runCleanup([
    ...closers,
    ...scratches.map((s) => [`drop ${s.name}`, () => s.drop()] as const),
    ...sets.map((s) => ["remove a temporary migrations copy", async () => s.remove()] as const),
  ]);
});

async function scratchDatabase(label: string, through?: string): Promise<ScratchDatabase> {
  const set = through === undefined ? undefined : migrationSet({ through });
  if (set) sets.push(set);
  const scratch = await createMigratedScratchDatabase(label, { migrate: (url) => deployMigrations(url, set) });
  scratches.push(scratch);
  return scratch;
}

/** finora_app's URL for a scratch database (the role is cluster-wide). */
function appUrl(scratch: ScratchDatabase): string {
  const url = new URL(inject("local").appDatabaseUrl);
  url.pathname = `/${scratch.name}`;
  return url.toString();
}

/** The finance service as finora_app on a scratch database. */
function financeOn(scratch: ScratchDatabase) {
  const prisma = createPrismaClient(appUrl(scratch), 1);
  closers.push(["disconnect a scratch Prisma client", () => prisma.$disconnect()]);
  return { prisma, finance: financeFor(prisma) };
}

/** A raw connection as finora_app on a scratch database (RLS and grants apply). */
async function appClientOn(scratch: ScratchDatabase): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: appUrl(scratch) });
  await client.connect();
  closers.push(["close a scratch app connection", () => client.end()]);
  return client;
}

/** Journal lines of an entry as [ledger account kind, side, amount, currency]. */
async function lines(db: pg.Client, entryId: string) {
  const { rows } = await db.query(
    `SELECT la.kind::text AS kind, l.side::text AS side, l.amount_minor::text AS amount, la.currency_code AS currency
       FROM finora.journal_lines l JOIN finora.ledger_accounts la ON la.id = l.account_id
      WHERE l.entry_id = $1 ORDER BY l.line_no`,
    [entryId],
  );
  return rows.map((r) => [r.kind, r.side, r.amount, r.currency]);
}

/** The ledger accounts an entry touches, as [ledger account id, side, amount]. */
async function entryAccounts(db: pg.Client, entryId: string) {
  const { rows } = await db.query(
    `SELECT l.account_id::text AS account, l.side::text AS side, l.amount_minor::text AS amount
       FROM finora.journal_lines l WHERE l.entry_id = $1 ORDER BY l.line_no`,
    [entryId],
  );
  return rows.map((r) => [r.account, r.side, r.amount]);
}

async function counts(db: pg.Client, ownerId: string) {
  const { rows } = await db.query(
    `SELECT (SELECT count(*) FROM finora.transactions WHERE owner_id = $1)::int AS transactions,
            (SELECT count(*) FROM finora.journal_entries WHERE owner_id = $1)::int AS entries,
            (SELECT count(*) FROM finora.journal_lines WHERE owner_id = $1)::int AS lines`,
    [ownerId],
  );
  return rows[0] as { transactions: number; entries: number; lines: number };
}

/** Every business and ledger row, so any change by the migration shows. */
async function dataSnapshot(db: pg.Client) {
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
  for (const [table, order] of tables) out[table] = (await db.query(`SELECT * FROM finora.${table} ORDER BY ${order}`)).rows;
  return out;
}

/** Every finora function's security attributes, owner, privileges and body. */
async function functionCatalog(db: pg.Client) {
  const { rows } = await db.query(
    `SELECT p.proname, p.prosecdef, p.provolatile, coalesce(array_to_string(p.proconfig, ','), '') AS config,
            pg_get_userbyid(p.proowner) AS owner, coalesce(p.proacl::text, '') AS acl, md5(pg_get_functiondef(p.oid)) AS body
       FROM pg_proc p WHERE p.pronamespace = 'finora'::regnamespace ORDER BY p.proname, p.oid`,
  );
  return rows as { proname: string; body: string }[];
}

/** Every user trigger on finora tables, with its wiring and enabled state. */
async function triggerCatalog(db: pg.Client) {
  const { rows } = await db.query(
    `SELECT t.tgrelid::regclass::text AS tbl, t.tgname, t.tgfoid::regproc::text AS fn, t.tgenabled, t.tgtype,
            t.tgdeferrable, t.tginitdeferred
       FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE c.relnamespace = 'finora'::regnamespace AND NOT t.tgisinternal ORDER BY 1, 2`,
  );
  return rows;
}

/** Every CHECK and foreign-key constraint on finora.transactions, by name. */
async function constraintCatalog(db: pg.Client) {
  const { rows } = await db.query(
    `SELECT con.conname, con.contype::text AS contype, con.convalidated, pg_get_constraintdef(con.oid) AS def
       FROM pg_constraint con WHERE con.conrelid = 'finora.transactions'::regclass ORDER BY con.conname`,
  );
  return rows as { conname: string; contype: string; convalidated: boolean; def: string }[];
}

async function migrationRows(db: pg.Client, name: string) {
  const { rows } = await db.query(
    `SELECT finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back
       FROM finora._prisma_migrations WHERE migration_name = $1 ORDER BY started_at`,
    [name],
  );
  return rows;
}

/** A new owner with the default categories on `scratch`. */
async function newOwner(db: pg.Client, finance: ReturnType<typeof financeFor>, prisma: Parameters<typeof authorize>[0]) {
  const seeded = await seedOwner(db);
  const owner = await authorize(prisma, seeded.subject);
  await finance.initializeDefaultCategories(owner);
  const categories = await finance.listCategories(owner);
  const named = (name: string) => categories.find((c) => c.name === name)!;
  return { seeded, owner, named };
}

describe("migrations 20261026000000_card_payment_kind and 20261026000100_card_payments", () => {
  it("add a kind and a rule without changing a row, a trigger or any other rule, and then accept card payments", async () => {
    const scratch = await scratchDatabase("cardpay_migrate", BEFORE);
    const db = scratch.client;
    const app = await appClientOn(scratch);
    const { prisma, finance } = financeOn(scratch);
    const { seeded, owner, named } = await newOwner(db, finance, prisma);

    // Representative 5B history: a bank account, a card, their opening
    // balances, income, a card expense, an ordinary expense and a void. The
    // accounts go through the service, but the transactions cannot: the
    // finance store reads and writes columns that migrations after 5C add
    // (see historyOn).
    const bank = (await finance.createAccount(owner, { name: "Axis", type: "bank", idempotencyKey: randomUUID() })).value;
    const card = (await finance.createAccount(owner, { name: "HDFC Card", type: "credit_card", idempotencyKey: randomUUID() })).value;
    const history = historyOn({ db, ledger: ledgerFor(prisma), owner, ownerId: seeded.ownerId, date: today });
    const equity = await history.openingEquity();
    const salaryLedger = await history.mapCategory(named("Salary").id, "income");
    const shoppingLedger = await history.mapCategory(named("Shopping").id, "expense");
    const groceriesLedger = await history.mapCategory(named("Groceries").id, "expense");
    await history.record({ kind: "opening_balance", amount: "50000", debit: bank.ledgerAccountId, credit: equity, destination: bank.id });
    await history.record({ kind: "opening_balance", amount: "12000", debit: equity, credit: card.ledgerAccountId, destination: card.id });
    await history.record({ kind: "income", amount: "1000", debit: bank.ledgerAccountId, credit: salaryLedger, destination: bank.id, category: named("Salary").id });
    await history.record({ kind: "expense", amount: "1250", debit: shoppingLedger, credit: card.ledgerAccountId, source: card.id, category: named("Shopping").id });
    const spent = await history.record({ kind: "expense", amount: "250", debit: groceriesLedger, credit: bank.ledgerAccountId, source: bank.id, category: named("Groceries").id });
    await history.void(spent);

    // Before the migrations the kind does not exist at all, so not even raw
    // SQL can record one.
    await expect(
      asOwner(app, seeded.ownerId, () =>
        app.query(
          `INSERT INTO finora.transactions (owner_id, kind, occurred_on, amount_minor, currency_code, source_account_id, destination_account_id, journal_entry_id)
           VALUES ($1, 'card_payment', $2, 500000, 'INR', $3, $4, gen_random_uuid())`,
          [seeded.ownerId, today, bank.id, card.id],
        ),
      ),
    ).rejects.toThrow(/invalid input value for enum finora\.transaction_kind/);

    const before = await dataSnapshot(db);
    const functionsBefore = await functionCatalog(db);
    const triggersBefore = await triggerCatalog(db);
    const constraintsBefore = await constraintCatalog(db);
    const shapeBefore = constraintsBefore.find((c) => c.conname === "transactions_shape")!;
    expect(shapeBefore.def).not.toMatch(/card_payment/);

    // The real project migrations, as on a deployment, but stopping at 5C:
    // this test's subject is those two files, and later milestones change the
    // catalogs compared below.
    const upTo5C = migrationSet({ through: CARD_PAYMENTS });
    sets.push(upTo5C);
    deployMigrations(scratch.url, upTo5C);

    expect(await migrationRows(db, CARD_PAYMENT_KIND)).toEqual([{ finished: true, rolled_back: false }]);
    expect(await migrationRows(db, CARD_PAYMENTS)).toEqual([{ finished: true, rolled_back: false }]);
    // No row is written or rewritten, and no trigger is added, removed or rewired.
    expect(await dataSnapshot(db)).toEqual(before);
    expect(await triggerCatalog(db)).toEqual(triggersBefore);
    // Same functions with the same attributes, owner and privileges; only
    // assert_transaction_valid's body differs.
    const functionsAfter = await functionCatalog(db);
    const withoutBody = (rows: { proname: string; body: string }[]) => rows.map((row) => ({ ...row, body: undefined }));
    expect(withoutBody(functionsAfter)).toEqual(withoutBody(functionsBefore));
    expect(functionsAfter.filter((f, i) => f.body !== functionsBefore[i]!.body).map((f) => f.proname)).toEqual(["assert_transaction_valid"]);
    // Only transactions_shape changed, and it is validated (so every existing
    // row satisfies it): same constraint names, same foreign keys.
    const constraintsAfter = await constraintCatalog(db);
    expect(constraintsAfter.map((c) => c.conname)).toEqual(constraintsBefore.map((c) => c.conname));
    expect(constraintsAfter.filter((c) => c.def !== constraintsBefore.find((b) => b.conname === c.conname)!.def).map((c) => c.conname)).toEqual([
      "transactions_shape",
    ]);
    const shapeAfter = constraintsAfter.find((c) => c.conname === "transactions_shape")!;
    expect(shapeAfter.convalidated).toBe(true);
    expect(shapeAfter.def).toMatch(/card_payment/);
    expect(shapeAfter.def).toMatch(/ELSE false/i);
    // The enum gained exactly one value, at the end.
    const kinds = await db.query("SELECT unnest(enum_range(NULL::finora.transaction_kind))::text AS kind");
    expect(kinds.rows.map((r) => r.kind)).toEqual(["opening_balance", "income", "expense", "transfer", "card_payment"]);

    // The remaining migrations, so the application path can be exercised too
    // (this working tree's finance store needs the columns they add).
    deployMigrations(scratch.url);

    // And now a card payment works, reducing the amount owed and the bank balance.
    expect((await finance.getAccount(owner, card.id)).balance.toDecimalString()).toBe("13250.00");
    expect((await finance.getAccount(owner, bank.id)).balance.toDecimalString()).toBe("51000.00");
    const payment = await finance.recordTransaction(owner, {
      kind: "card_payment",
      amount: "5000",
      date: today,
      sourceAccountId: bank.id,
      destinationAccountId: card.id,
      idempotencyKey: randomUUID(),
    });
    expect(await lines(db, payment.value.journalEntryId)).toEqual([
      ["liability", "debit", "500000", "INR"],
      ["asset", "credit", "500000", "INR"],
    ]);
    expect((await finance.getAccount(owner, card.id)).balance.toDecimalString()).toBe("8250.00");
    expect((await finance.getAccount(owner, bank.id)).balance.toDecimalString()).toBe("46000.00");
  }, 180_000);
});

describe("card payments (migrated scratch database)", () => {
  let scratch: ScratchDatabase;
  let db: pg.Client;
  let app: pg.Client;
  let finance: ReturnType<typeof financeFor>;
  let prisma: Parameters<typeof authorize>[0];

  beforeAll(async () => {
    scratch = await scratchDatabase("cardpay");
    db = scratch.client;
    app = await appClientOn(scratch);
    ({ prisma, finance } = financeOn(scratch));
  }, 120_000);

  const fresh = () => newOwner(db, finance, prisma);
  const balanceOf = async (owner: AuthorizedOwner, id: string) => (await finance.getAccount(owner, id)).balance.toDecimalString();
  const card = async (owner: AuthorizedOwner, name: string, extra: Record<string, unknown> = {}) =>
    (await finance.createAccount(owner, { name, type: "credit_card", idempotencyKey: randomUUID(), ...extra })).value;
  const bank = async (owner: AuthorizedOwner, name: string, extra: Record<string, unknown> = {}) =>
    (await finance.createAccount(owner, { name, type: "bank", idempotencyKey: randomUUID(), ...extra })).value;
  const pay = (owner: AuthorizedOwner, extra: Record<string, unknown>) =>
    finance.recordTransaction(owner, { kind: "card_payment", amount: "5000", date: today, idempotencyKey: randomUUID(), ...extra });

  describe("service", () => {
    it("posts Dr the card / Cr the paying account, so the amount owed and the balance both fall", async () => {
      const { seeded, owner } = await fresh();
      const hdfc = await card(owner, "HDFC Card", { openingBalance: { amount: "12000", date: "2026-10-01" } });
      const axis = await bank(owner, "Axis", { openingBalance: { amount: "50000", date: "2026-10-01" } });
      const before = await counts(db, seeded.ownerId);

      const { value: payment, replayed } = await pay(owner, {
        amount: "5000.00",
        date: "2026-10-24",
        sourceAccountId: axis.id,
        destinationAccountId: hdfc.id,
        note: "Oct statement",
      });
      expect(replayed).toBe(false);
      expect(payment).toMatchObject({
        kind: "card_payment",
        occurredOn: "2026-10-24",
        sourceAccountId: axis.id,
        destinationAccountId: hdfc.id,
        categoryId: null,
        payee: null,
        note: "Oct statement",
      });
      expect(payment.amount.toDecimalString()).toBe("5000.00");
      expect(await lines(db, payment.journalEntryId)).toEqual([
        ["liability", "debit", "500000", "INR"],
        ["asset", "credit", "500000", "INR"],
      ]);
      // Exactly the card's and the bank's own ledger accounts: no category.
      expect(await entryAccounts(db, payment.journalEntryId)).toEqual([
        [hdfc.ledgerAccountId, "debit", "500000"],
        [axis.ledgerAccountId, "credit", "500000"],
      ]);
      expect(await counts(db, seeded.ownerId)).toEqual({
        transactions: before.transactions + 1,
        entries: before.entries + 1,
        lines: before.lines + 2,
      });
      expect(await balanceOf(owner, hdfc.id)).toBe("7000.00"); // owed: 12,000 − 5,000
      expect(await balanceOf(owner, axis.id)).toBe("45000.00"); // held: 50,000 − 5,000

      // It is in both accounts' histories, and in neither expense nor income totals.
      const cardHistory = await finance.listTransactions(owner, { accountId: hdfc.id });
      expect(cardHistory.map((t) => [t.kind, t.amount.toDecimalString()])).toEqual([
        ["card_payment", "5000.00"],
        ["opening_balance", "12000.00"],
      ]);
      expect((await finance.listTransactions(owner, { accountId: axis.id })).map((t) => t.kind)).toEqual(["card_payment", "opening_balance"]);
      expect(await finance.listTransactions(owner, { kind: "expense" })).toEqual([]);
      expect(await finance.listTransactions(owner, { kind: "income" })).toEqual([]);
      expect((await finance.listTransactions(owner, { kind: "card_payment" })).map((t) => t.id)).toEqual([payment.id]);
    });

    it("does not count as an expense even when the card also has expenses", async () => {
      const { owner, named } = await fresh();
      const hdfc = await card(owner, "Mixed card");
      const axis = await bank(owner, "Mixed bank", { openingBalance: { amount: "10000", date: today } });
      await finance.recordTransaction(owner, {
        kind: "expense",
        amount: "1250",
        date: today,
        sourceAccountId: hdfc.id,
        categoryId: named("Shopping").id,
        idempotencyKey: randomUUID(),
      });
      expect(await balanceOf(owner, hdfc.id)).toBe("1250.00");
      await pay(owner, { amount: "1250", sourceAccountId: axis.id, destinationAccountId: hdfc.id });

      expect(await balanceOf(owner, hdfc.id)).toBe("0.00"); // nothing owed
      expect(await balanceOf(owner, axis.id)).toBe("8750.00");
      // The expense total is the one purchase; the payment is not in it.
      const expenses = await finance.listTransactions(owner, { kind: "expense" });
      expect(expenses.map((t) => t.amount.toDecimalString())).toEqual(["1250.00"]);
      expect(expenses.map((t) => t.destinationAccountId)).toEqual([null]);
    });

    it("pays more than is owed, leaving a credit balance in the owner's favour", async () => {
      const { owner } = await fresh();
      const hdfc = await card(owner, "Overpaid card", { openingBalance: { amount: "1000", date: today } });
      const axis = await bank(owner, "Overpay bank", { openingBalance: { amount: "10000", date: today } });
      await pay(owner, { amount: "1500", sourceAccountId: axis.id, destinationAccountId: hdfc.id });
      // A liability's normal balance is credits − debits, so it goes negative.
      expect(await balanceOf(owner, hdfc.id)).toBe("-500.00");
      expect(await balanceOf(owner, axis.id)).toBe("8500.00");
    });

    it("pays a card that owes nothing at all", async () => {
      const { owner } = await fresh();
      const hdfc = await card(owner, "Zero card");
      const axis = await bank(owner, "Zero bank", { openingBalance: { amount: "100", date: today } });
      await pay(owner, { amount: "100", sourceAccountId: axis.id, destinationAccountId: hdfc.id });
      expect(await balanceOf(owner, hdfc.id)).toBe("-100.00");
      expect(await balanceOf(owner, axis.id)).toBe("0.00");
    });

    it("pays from a cash account too, in the card's own currency and precision", async () => {
      const { owner } = await fresh();
      const wallet = (await finance.createAccount(owner, { name: "Wallet", type: "cash", openingBalance: { amount: "5000", date: today }, idempotencyKey: randomUUID() })).value;
      const hdfc = await card(owner, "Cash-paid card", { openingBalance: { amount: "3000", date: today } });
      const { value } = await pay(owner, { amount: "1234.56", sourceAccountId: wallet.id, destinationAccountId: hdfc.id });
      expect(value.amount.currency.code).toBe("INR");
      expect(await lines(db, value.journalEntryId)).toEqual([
        ["liability", "debit", "123456", "INR"],
        ["asset", "credit", "123456", "INR"],
      ]);
      expect(await balanceOf(owner, hdfc.id)).toBe("1765.44");
      expect(await balanceOf(owner, wallet.id)).toBe("3765.44");
    });

    it("posts a USD card payment in USD, and refuses an over-precise amount", async () => {
      const { owner } = await fresh();
      const usdCard = await card(owner, "USD card", { currency: "USD", openingBalance: { amount: "100", date: today } });
      const usdBank = await bank(owner, "USD bank", { currency: "USD", openingBalance: { amount: "500", date: today } });
      await expect(pay(owner, { amount: "12.345", sourceAccountId: usdBank.id, destinationAccountId: usdCard.id })).rejects.toMatchObject({
        issues: [expect.objectContaining({ field: "amount", message: expect.stringMatching(/USD/) })],
      });
      const { value } = await pay(owner, { amount: "12.34", sourceAccountId: usdBank.id, destinationAccountId: usdCard.id });
      expect(value.amount.currency.code).toBe("USD");
      expect(await lines(db, value.journalEntryId)).toEqual([
        ["liability", "debit", "1234", "USD"],
        ["asset", "credit", "1234", "USD"],
      ]);
      expect(await balanceOf(owner, usdCard.id)).toBe("87.66");
    });

    it("refuses a currency mismatch between the card and the paying account, writing nothing", async () => {
      const { seeded, owner } = await fresh();
      const inrCard = await card(owner, "INR card", { openingBalance: { amount: "1000", date: today } });
      const usdBank = await bank(owner, "Mismatch bank", { currency: "USD", openingBalance: { amount: "500", date: today } });
      const before = await counts(db, seeded.ownerId);
      await expect(pay(owner, { sourceAccountId: usdBank.id, destinationAccountId: inrCard.id })).rejects.toMatchObject({
        issues: [{ field: "destinationAccountId", message: expect.stringMatching(/same currency \(USD and INR\)/) }],
      });
      expect(await counts(db, seeded.ownerId)).toEqual(before);
      expect(await balanceOf(owner, inrCard.id)).toBe("1000.00");
      expect(await balanceOf(owner, usdBank.id)).toBe("500.00");
    });

    it.each([
      ["zero", "0"],
      ["negative", "-5000"],
      ["over-precise for INR", "100.005"],
      ["not a number", "five thousand"],
    ])("refuses a %s amount, writing nothing", async (_label, amount) => {
      const { seeded, owner } = await fresh();
      const hdfc = await card(owner, `Amount card ${amount}`, { openingBalance: { amount: "1000", date: today } });
      const axis = await bank(owner, `Amount bank ${amount}`, { openingBalance: { amount: "9000", date: today } });
      const before = await counts(db, seeded.ownerId);
      await expect(pay(owner, { amount, sourceAccountId: axis.id, destinationAccountId: hdfc.id })).rejects.toMatchObject({
        issues: [expect.objectContaining({ field: "amount" })],
      });
      expect(await counts(db, seeded.ownerId)).toEqual(before);
      expect(await balanceOf(owner, hdfc.id)).toBe("1000.00");
      expect(await balanceOf(owner, axis.id)).toBe("9000.00");
    });

    it("refuses the wrong account types on either side, writing nothing", async () => {
      const { seeded, owner } = await fresh();
      const hdfc = await card(owner, "Types card A");
      const icici = await card(owner, "Types card B");
      const axis = await bank(owner, "Types bank", { openingBalance: { amount: "1000", date: today } });
      const wallet = (await finance.createAccount(owner, { name: "Types wallet", type: "cash", idempotencyKey: randomUUID() })).value;
      const before = await counts(db, seeded.ownerId);

      // A bank or cash account is never the card being paid. (Two different
      // accounts each time, so this is the type rule and not the
      // same-account rule.)
      for (const [source, destination] of [
        [wallet.id, axis.id],
        [axis.id, wallet.id],
      ]) {
        await expect(pay(owner, { sourceAccountId: source, destinationAccountId: destination })).rejects.toMatchObject({
          issues: [{ field: "destinationAccountId", message: expect.stringMatching(/is not a credit card; choose a credit card/) }],
        });
      }
      // A card never pays another card.
      await expect(pay(owner, { sourceAccountId: hdfc.id, destinationAccountId: icici.id })).rejects.toMatchObject({
        issues: [{ field: "sourceAccountId", message: expect.stringMatching(/is a credit card; a card can only pay for an expense, be paid by a card payment or be credited by a card refund/) }],
      });
      // And a card never pays itself: the same account on both sides is
      // refused while parsing, before any class is looked up.
      await expect(pay(owner, { sourceAccountId: hdfc.id, destinationAccountId: hdfc.id })).rejects.toMatchObject({
        issues: [{ field: "destinationAccountId", message: "Choose two different accounts" }],
      });
      expect(await counts(db, seeded.ownerId)).toEqual(before);
      expect(await balanceOf(owner, axis.id)).toBe("1000.00");
      expect(await balanceOf(owner, hdfc.id)).toBe("0.00");
    });

    it("refuses an archived card or paying account, and another owner's accounts, writing nothing", async () => {
      const { seeded, owner } = await fresh();
      const other = await fresh();
      const hdfc = await card(owner, "Archive card", { openingBalance: { amount: "2000", date: today } });
      const axis = await bank(owner, "Archive bank", { openingBalance: { amount: "9000", date: today } });
      const theirCard = await card(other.owner, "Their card", { openingBalance: { amount: "100", date: today } });
      const theirBank = await bank(other.owner, "Their bank", { openingBalance: { amount: "100", date: today } });
      const before = await counts(db, seeded.ownerId);
      const mine = { sourceAccountId: axis.id, destinationAccountId: hdfc.id };

      await finance.archiveAccount(owner, hdfc.id);
      await expect(pay(owner, mine)).rejects.toMatchObject({
        issues: [{ field: "destinationAccountId", message: expect.stringMatching(/is archived/) }],
      });
      await finance.restoreAccount(owner, hdfc.id);

      await finance.archiveAccount(owner, axis.id);
      await expect(pay(owner, mine)).rejects.toMatchObject({
        issues: [{ field: "sourceAccountId", message: expect.stringMatching(/is archived/) }],
      });
      await finance.restoreAccount(owner, axis.id);

      // Another owner's accounts are simply not visible under this owner.
      await expect(pay(owner, { sourceAccountId: axis.id, destinationAccountId: theirCard.id })).rejects.toMatchObject({
        issues: [{ field: "destinationAccountId", message: "That account does not exist" }],
      });
      await expect(pay(owner, { sourceAccountId: theirBank.id, destinationAccountId: hdfc.id })).rejects.toMatchObject({
        issues: [{ field: "sourceAccountId", message: "That account does not exist" }],
      });
      expect(await counts(db, seeded.ownerId)).toEqual(before);
      expect(await balanceOf(other.owner, theirCard.id)).toBe("100.00");
      expect(await balanceOf(other.owner, theirBank.id)).toBe("100.00");
      // The owner's own payment still works once nothing is archived.
      await expect(pay(owner, mine)).resolves.toMatchObject({ replayed: false });
    });

    it("replays a retried payment once, and refuses the same key for any other business field, writing nothing", async () => {
      const { seeded, owner, named } = await fresh();
      const hdfc = await card(owner, "Retry card");
      const other = await card(owner, "Retry card 2");
      const axis = await bank(owner, "Retry bank", { openingBalance: { amount: "50000", date: today } });
      const wallet = (await finance.createAccount(owner, { name: "Retry wallet", type: "cash", openingBalance: { amount: "5000", date: today }, idempotencyKey: randomUUID() })).value;
      const input = {
        kind: "card_payment",
        amount: "5000",
        date: today,
        sourceAccountId: axis.id,
        destinationAccountId: hdfc.id,
        note: "Oct statement",
        idempotencyKey: randomUUID(),
      };
      const first = await finance.recordTransaction(owner, input);
      const after = await counts(db, seeded.ownerId);
      expect(await finance.recordTransaction(owner, input)).toEqual({ value: first.value, replayed: true });

      for (const change of [
        { destinationAccountId: other.id },
        { sourceAccountId: wallet.id },
        { amount: "5000.01" },
        { date: "2026-10-24" },
        { note: "Nov statement" },
        { note: null },
        // The same key for a different kind of request is a conflict too.
        { kind: "expense", destinationAccountId: undefined, sourceAccountId: axis.id, categoryId: named("Groceries").id },
        { kind: "transfer", destinationAccountId: wallet.id },
      ]) {
        await expect(finance.recordTransaction(owner, { ...input, ...change }), JSON.stringify(change)).rejects.toThrow(IdempotencyConflictError);
      }
      expect(await counts(db, seeded.ownerId)).toEqual(after);
      expect(await balanceOf(owner, hdfc.id)).toBe("-5000.00");
      expect(await balanceOf(owner, other.id)).toBe("0.00");
      expect(await balanceOf(owner, axis.id)).toBe("45000.00");
      expect(await balanceOf(owner, wallet.id)).toBe("5000.00");
    });

    it("voids a payment with its exact mirror, so the amount owed comes back", async () => {
      const { owner } = await fresh();
      const hdfc = await card(owner, "Void card", { openingBalance: { amount: "4000", date: today } });
      const axis = await bank(owner, "Void bank", { openingBalance: { amount: "9000", date: today } });
      const { value } = await pay(owner, { amount: "1500", sourceAccountId: axis.id, destinationAccountId: hdfc.id });
      expect(await balanceOf(owner, hdfc.id)).toBe("2500.00");
      expect(await balanceOf(owner, axis.id)).toBe("7500.00");

      const voided = await finance.voidTransaction(owner, value.id, { date: today, idempotencyKey: randomUUID() });
      expect(await lines(db, voided.value.reversalEntryId!)).toEqual([
        ["liability", "credit", "150000", "INR"],
        ["asset", "debit", "150000", "INR"],
      ]);
      expect(await balanceOf(owner, hdfc.id)).toBe("4000.00");
      expect(await balanceOf(owner, axis.id)).toBe("9000.00");
      // Voiding again with another key is refused; nothing changes.
      await expect(finance.voidTransaction(owner, value.id, { date: today, idempotencyKey: randomUUID() })).rejects.toThrow(
        /already been voided or corrected/,
      );
      expect(await balanceOf(owner, hdfc.id)).toBe("4000.00");
      expect(await balanceOf(owner, axis.id)).toBe("9000.00");
    });

    it("has no payee, and keeps a note editable without touching the journal", async () => {
      const { owner } = await fresh();
      const hdfc = await card(owner, "Note card");
      const axis = await bank(owner, "Note bank", { openingBalance: { amount: "900", date: today } });
      const { value } = await pay(owner, { amount: "900", sourceAccountId: axis.id, destinationAccountId: hdfc.id });
      await expect(finance.updateTransactionDetails(owner, value.id, { payee: "HDFC", note: null })).rejects.toMatchObject({
        issues: [{ field: "payee", message: "Transfers, card payments and opening balances have no payee" }],
      });
      await finance.updateTransactionDetails(owner, value.id, { payee: null, note: "Paid in full" });
      expect((await finance.getTransaction(owner, value.id)).note).toBe("Paid in full");
      // The journal keeps the original text, so the fingerprint is unchanged.
      const { rows } = await db.query("SELECT memo FROM finora.journal_lines WHERE entry_id = $1 ORDER BY line_no", [value.journalEntryId]);
      expect(rows.map((r) => r.memo)).toEqual([null, null]);
    });

    it("derives both balances from posted lines alone, with no stored-balance drift", async () => {
      const { owner } = await fresh();
      const hdfc = await card(owner, "Drift card", { openingBalance: { amount: "10000", date: today } });
      const axis = await bank(owner, "Drift bank", { openingBalance: { amount: "20000", date: today } });
      for (const amount of ["1000", "2500.50", "0.01"]) {
        await pay(owner, { amount, sourceAccountId: axis.id, destinationAccountId: hdfc.id });
      }
      expect(await balanceOf(owner, hdfc.id)).toBe("6499.49"); // 10,000 − 3,500.51
      expect(await balanceOf(owner, axis.id)).toBe("16499.49"); // 20,000 − 3,500.51
      // The same figures straight from the ledger: credits − debits for the
      // card, debits − credits for the bank account.
      const normal = async (ledgerAccountId: string, sign: 1 | -1) =>
        (
          await db.query(
            `SELECT (${sign} * sum(CASE WHEN side = 'credit' THEN amount_minor ELSE -amount_minor END))::text AS total
               FROM finora.journal_lines l JOIN finora.journal_entries e ON e.id = l.entry_id
              WHERE l.account_id = $1 AND e.status = 'posted'`,
            [ledgerAccountId],
          )
        ).rows[0].total as string;
      expect(await normal(hdfc.ledgerAccountId, 1)).toBe("649949");
      expect(await normal(axis.ledgerAccountId, -1)).toBe("1649949");
    });
  });

  describe("database rules at COMMIT (raw SQL as finora_app, bypassing the application)", () => {
    let ownerId: string;
    let cardId: string;
    let cardLedger: string;
    let card2Id: string;
    let card2Ledger: string;
    let bankId: string;
    let bankLedger: string;
    let walletId: string;
    let walletLedger: string;
    let usdCardId: string;
    let otherCardId: string;
    let groceriesId: string;
    let groceriesLedger: string;

    /** Posts a balanced two-line entry for the owner, returning its id. */
    async function postedEntry(debit: string, credit: string, amount: number, currency = "INR"): Promise<string> {
      const { rows } = await app.query(
        "INSERT INTO finora.journal_entries (owner_id, entry_date, description) VALUES ($1, $2, 'raw') RETURNING id::text",
        [ownerId, today],
      );
      await app.query(
        `INSERT INTO finora.journal_lines (owner_id, entry_id, line_no, account_id, currency_code, side, amount_minor)
         VALUES ($1, $2, 1, $3, $6, 'debit', $5), ($1, $2, 2, $4, $6, 'credit', $5)`,
        [ownerId, rows[0].id, debit, credit, amount, currency],
      );
      await app.query("UPDATE finora.journal_entries SET status = 'posted' WHERE id = $1", [rows[0].id]);
      return rows[0].id as string;
    }

    const insert = (row: {
      kind: string;
      amount: number;
      source?: string | null;
      destination?: string | null;
      category?: string | null;
      entry: string;
      currency?: string;
    }) =>
      app.query(
        `INSERT INTO finora.transactions (owner_id, kind, occurred_on, amount_minor, currency_code,
           source_account_id, destination_account_id, category_id, journal_entry_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [ownerId, row.kind, today, row.amount, row.currency ?? "INR", row.source ?? null, row.destination ?? null, row.category ?? null, row.entry],
      );
    const asTheOwner = <T>(work: () => Promise<T>) => asOwner(app, ownerId, work);
    const paymentsOn = async (id: string) =>
      (await db.query("SELECT count(*)::int AS n FROM finora.transactions WHERE kind = 'card_payment' AND destination_account_id = $1", [id])).rows[0]
        .n as number;

    beforeAll(async () => {
      const { seeded, owner, named } = await fresh();
      const other = await fresh();
      ownerId = seeded.ownerId;
      const hdfc = await card(owner, "Raw pay card");
      const icici = await card(owner, "Raw pay card 2");
      const axis = await bank(owner, "Raw pay bank", { openingBalance: { amount: "100000", date: today } });
      const wallet = (await finance.createAccount(owner, { name: "Raw pay wallet", type: "cash", idempotencyKey: randomUUID() })).value;
      [cardId, cardLedger, card2Id, card2Ledger] = [hdfc.id, hdfc.ledgerAccountId, icici.id, icici.ledgerAccountId];
      [bankId, bankLedger, walletId, walletLedger] = [axis.id, axis.ledgerAccountId, wallet.id, wallet.ledgerAccountId];
      usdCardId = (await card(owner, "Raw pay USD card", { currency: "USD" })).id;
      otherCardId = (await card(other.owner, "Other owner's paid card")).id;
      groceriesId = named("Groceries").id;
      // Map the category in INR through the application (first use creates it).
      await finance.recordTransaction(owner, {
        kind: "expense",
        amount: "1",
        date: today,
        sourceAccountId: bankId,
        categoryId: groceriesId,
        idempotencyKey: randomUUID(),
      });
      groceriesLedger = (
        await db.query("SELECT ledger_account_id::text AS id FROM finora.category_ledger_accounts WHERE category_id = $1 AND currency_code = 'INR'", [
          groceriesId,
        ])
      ).rows[0].id as string;
    }, 60_000);

    it("accepts a payment whose entry is exactly Dr the card / Cr the paying account", async () => {
      const before = await paymentsOn(cardId);
      await asTheOwner(async () => insert({ kind: "card_payment", amount: 500000, source: bankId, destination: cardId, entry: await postedEntry(cardLedger, bankLedger, 500000) }));
      await asTheOwner(async () => insert({ kind: "card_payment", amount: 2500, source: walletId, destination: cardId, entry: await postedEntry(cardLedger, walletLedger, 2500) }));
      expect(await paymentsOn(cardId)).toBe(before + 2);
    });

    it.each([
      ["the wrong direction (Dr the bank / Cr the card)", () => ({ debit: bankLedger, credit: cardLedger, entryAmount: 500, amount: 500 })],
      ["another card's liability account", () => ({ debit: card2Ledger, credit: bankLedger, entryAmount: 500, amount: 500 })],
      ["a category account instead of the card", () => ({ debit: groceriesLedger, credit: bankLedger, entryAmount: 500, amount: 500 })],
      ["a different amount", () => ({ debit: cardLedger, credit: bankLedger, entryAmount: 500, amount: 501 })],
    ])("refuses a payment whose entry has %s", async (_label, parts) => {
      const { debit, credit, entryAmount, amount } = parts();
      const before = await paymentsOn(cardId);
      await expect(
        asTheOwner(async () => insert({ kind: "card_payment", amount, source: bankId, destination: cardId, entry: await postedEntry(debit, credit, entryAmount) })),
      ).rejects.toThrow(/the journal entry does not match the transaction/);
      expect(await paymentsOn(cardId)).toBe(before);
    });

    it.each([
      ["a bank account as the card being paid", () => ({ source: walletId, destination: bankId, debit: bankLedger, credit: walletLedger })],
      ["a cash account as the card being paid", () => ({ source: bankId, destination: walletId, debit: walletLedger, credit: bankLedger })],
      ["a card as the paying account (card to card)", () => ({ source: card2Id, destination: cardId, debit: cardLedger, credit: card2Ledger })],
    ])("refuses %s at COMMIT, even with an entry matching the template", async (_label, make) => {
      const { debit, credit, ...row } = make();
      const before = await paymentsOn(row.destination);
      await expect(asTheOwner(async () => insert({ kind: "card_payment", amount: 700, ...row, entry: await postedEntry(debit, credit, 700) }))).rejects.toThrow(
        WRONG_CLASSES,
      );
      expect(await paymentsOn(row.destination)).toBe(before);
    });

    it("refuses a payment with a missing side, the same account twice, or a category (the row CHECKs and insert guard)", async () => {
      await expect(
        asTheOwner(async () => insert({ kind: "card_payment", amount: 500, source: null, destination: cardId, entry: await postedEntry(cardLedger, bankLedger, 500) })),
      ).rejects.toThrow(/transactions_shape/);
      await expect(
        asTheOwner(async () => insert({ kind: "card_payment", amount: 500, source: bankId, destination: null, entry: await postedEntry(cardLedger, bankLedger, 500) })),
      ).rejects.toThrow(/transactions_shape/);
      await expect(
        asTheOwner(async () => insert({ kind: "card_payment", amount: 500, source: cardId, destination: cardId, entry: await postedEntry(cardLedger, bankLedger, 500) })),
      ).rejects.toThrow(/transactions_shape/);
      // A category on a card payment is refused: the insert guard's
      // category-kind check fires first (BEFORE triggers run before row
      // CHECKs), and the shape CHECK would refuse it too.
      await expect(
        asTheOwner(async () =>
          insert({ kind: "card_payment", amount: 500, source: bankId, destination: cardId, category: groceriesId, entry: await postedEntry(cardLedger, bankLedger, 500) }),
        ),
      ).rejects.toThrow(/the category kind does not match the transaction|transactions_shape/);
    });

    it("refuses a payment to an archived card or from an archived account", async () => {
      for (const [id, message] of [
        [card2Id, /archived accounts cannot take new transactions/],
        [bankId, /archived accounts cannot take new transactions/],
      ] as const) {
        await asTheOwner(() => app.query("UPDATE finora.financial_accounts SET archived_at = now() WHERE id = $1", [id]));
        try {
          await expect(
            asTheOwner(async () =>
              insert({
                kind: "card_payment",
                amount: 900,
                source: bankId,
                destination: card2Id,
                entry: await postedEntry(card2Ledger, bankLedger, 900),
              }),
            ),
          ).rejects.toThrow(message);
        } finally {
          await asTheOwner(() => app.query("UPDATE finora.financial_accounts SET archived_at = NULL WHERE id = $1", [id]));
        }
      }
    });

    it("refuses another owner's card and a currency other than the card's", async () => {
      await expect(
        asTheOwner(async () => insert({ kind: "card_payment", amount: 900, source: bankId, destination: otherCardId, entry: await postedEntry(cardLedger, bankLedger, 900) })),
      ).rejects.toThrow(/transactions_destination_account_fkey/);
      await expect(
        asTheOwner(async () => insert({ kind: "card_payment", amount: 900, source: bankId, destination: usdCardId, entry: await postedEntry(cardLedger, bankLedger, 900) })),
      ).rejects.toThrow(/transactions_destination_account_fkey/);
      expect(await paymentsOn(otherCardId)).toBe(0);
      expect(await paymentsOn(usdCardId)).toBe(0);
    });

    it("keeps a posted payment immutable: its kind, accounts and amount cannot be edited, and it cannot be deleted", async () => {
      const { rows } = await db.query(
        "SELECT id::text AS id FROM finora.transactions WHERE kind = 'card_payment' AND destination_account_id = $1 LIMIT 1",
        [cardId],
      );
      const id = rows[0].id as string;
      const edits: [string, unknown[]][] = [
        ["UPDATE finora.transactions SET kind = 'transfer' WHERE id = $1", [id]],
        ["UPDATE finora.transactions SET destination_account_id = $2 WHERE id = $1", [id, card2Id]],
        ["UPDATE finora.transactions SET source_account_id = $2 WHERE id = $1", [id, walletId]],
        ["UPDATE finora.transactions SET amount_minor = 1 WHERE id = $1", [id]],
        ["UPDATE finora.transactions SET occurred_on = '2026-01-01' WHERE id = $1", [id]],
      ];
      for (const [sql, params] of edits) {
        await expect(asTheOwner(() => app.query(sql, params))).rejects.toThrow(
          /a transaction's accounting fields are immutable|permission denied/,
        );
      }
      await expect(asTheOwner(() => app.query("DELETE FROM finora.transactions WHERE id = $1", [id]))).rejects.toThrow(
        /transactions are never deleted|permission denied/,
      );
    });

    it("still refuses a transfer to or from a card, so only a card payment pays a card", async () => {
      const before = await paymentsOn(cardId);
      await expect(
        asTheOwner(async () => insert({ kind: "transfer", amount: 700, source: bankId, destination: cardId, entry: await postedEntry(cardLedger, bankLedger, 700) })),
      ).rejects.toThrow(/income and transfers use bank and cash accounts only/);
      await expect(
        asTheOwner(async () => insert({ kind: "transfer", amount: 700, source: cardId, destination: bankId, entry: await postedEntry(bankLedger, cardLedger, 700) })),
      ).rejects.toThrow(/income and transfers use bank and cash accounts only/);
      expect(await paymentsOn(cardId)).toBe(before);
    });
  });
});
