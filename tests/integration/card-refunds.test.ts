import { randomUUID } from "node:crypto";

import pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import type { AuthorizedOwner } from "@/server/auth/types";
import { FinanceConflictError } from "@/server/finance/errors";
import { IdempotencyConflictError } from "@/server/ledger/errors";

import { lines, entryAccounts, counts, dataSnapshot, functionCatalog, triggerCatalog, constraintCatalog, migrationRows } from "./support/catalog";
import { asOwner, authorize, financeFor, ledgerFor } from "./support/ledger";
import { historyOn } from "./support/pre-migration";
import { type ScratchDatabase, deployMigrations } from "./support/scratch-db";
import { newOwner, scratchHarness } from "./support/scratch-harness";

/**
 * Milestone 5D (ADR 0008): card refunds, both linked to a recorded purchase
 * and unlinked (a merchant credit). Migrations 20261029000000_card_refund_kind
 * and 20261029000100_card_refunds, and the service and COMMIT-time rules they
 * enable, on scratch databases that this file creates and drops. Nothing here
 * touches the local database's own data.
 */

const CARD_REFUND_KIND = "20261029000000_card_refund_kind";
const CARD_REFUNDS = "20261029000100_card_refunds";
const BEFORE = "20261026000100_card_payments";
const today = "2026-10-25";
/** The COMMIT-time refusals this milestone adds. */
const NOT_A_CARD = /a card refund credits a credit card/;
const INELIGIBLE = /a card refund can only refund an active purchase paid by the same card, in its currency/;
const OVER_REFUNDED = /the refunds of a purchase cannot exceed what was paid for it/;
const REFUNDS_FIRST = /void a purchase's refunds before voiding the purchase/;

const { scratchDatabase, financeOn, appClientOn } = scratchHarness();

/** Debits minus credits on one ledger account, from posted lines only. */
async function normalBalance(db: pg.Client, ledgerAccountId: string): Promise<bigint> {
  const { rows } = await db.query(
    `SELECT coalesce(sum(CASE WHEN l.side = 'debit' THEN l.amount_minor ELSE -l.amount_minor END), 0)::text AS net
       FROM finora.journal_lines l JOIN finora.journal_entries e ON e.id = l.entry_id
      WHERE l.account_id = $1 AND e.status = 'posted'`,
    [ledgerAccountId],
  );
  return BigInt(rows[0].net);
}

/** finora_app's privileges on finora.transactions, per column. */
async function transactionGrants(db: pg.Client) {
  const { rows } = await db.query(
    `SELECT a.attname, string_agg(p.priv, ',' ORDER BY p.priv) AS privs
       FROM pg_attribute a
       CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE']) AS p(priv)
      WHERE a.attrelid = 'finora.transactions'::regclass AND a.attnum > 0 AND NOT a.attisdropped
        AND has_column_privilege('finora_app', a.attrelid, a.attnum, p.priv)
      GROUP BY a.attname ORDER BY a.attname`,
  );
  return Object.fromEntries(rows.map((r) => [r.attname, r.privs])) as Record<string, string>;
}

describe("migrations 20261029000000_card_refund_kind and 20261029000100_card_refunds", () => {
  it("add a kind, a column and rules without changing a row, a trigger or any other rule, and then accept refunds", async () => {
    const scratch = await scratchDatabase("cardrefund_migrate", BEFORE);
    const db = scratch.client;
    const app = await appClientOn(scratch);
    const { prisma, finance } = financeOn(scratch);
    const ledger = ledgerFor(prisma);
    const { seeded, owner, named } = await newOwner(db, finance, prisma);

    /**
     * Representative 5C history, written WITHOUT this milestone's code paths
     * (see historyOn): the finance store reads and writes
     * `refunds_transaction_id`, which this database does not have yet.
     */
    const bank = (await finance.createAccount(owner, { name: "Axis", type: "bank", idempotencyKey: randomUUID() })).value;
    const card = (await finance.createAccount(owner, { name: "HDFC Card", type: "credit_card", idempotencyKey: randomUUID() })).value;
    const history = historyOn({ db, ledger, owner, ownerId: seeded.ownerId, date: today });
    const equity = await history.openingEquity();
    const salaryLedger = await history.mapCategory(named("Salary").id, "income");
    const shoppingLedger = await history.mapCategory(named("Shopping").id, "expense");
    const groceriesLedger = await history.mapCategory(named("Groceries").id, "expense");

    // An opening balance on each account, income, a card expense, a
    // repayment, an ordinary expense and a void of it.
    await history.record({ kind: "opening_balance", amount: "50000", debit: bank.ledgerAccountId, credit: equity, destination: bank.id });
    await history.record({ kind: "opening_balance", amount: "12000", debit: equity, credit: card.ledgerAccountId, destination: card.id });
    await history.record({ kind: "income", amount: "1000", debit: bank.ledgerAccountId, credit: salaryLedger, destination: bank.id, category: named("Salary").id });
    const purchase = await history.record({ kind: "expense", amount: "1250", debit: shoppingLedger, credit: card.ledgerAccountId, source: card.id, category: named("Shopping").id, payee: "Bata" });
    await history.record({ kind: "card_payment", amount: "5000", debit: card.ledgerAccountId, credit: bank.ledgerAccountId, source: bank.id, destination: card.id });
    const spent = await history.record({ kind: "expense", amount: "250", debit: groceriesLedger, credit: bank.ledgerAccountId, source: bank.id, category: named("Groceries").id });
    await history.void(spent);

    // Before the migrations the kind does not exist at all, so not even raw
    // SQL can record one, and there is no column to link a purchase.
    await expect(
      asOwner(app, seeded.ownerId, () =>
        app.query(
          `INSERT INTO finora.transactions (owner_id, kind, occurred_on, amount_minor, currency_code, destination_account_id, category_id, journal_entry_id)
           VALUES ($1, 'card_refund', $2, 50000, 'INR', $3, $4, gen_random_uuid())`,
          [seeded.ownerId, today, card.id, named("Shopping").id],
        ),
      ),
    ).rejects.toThrow(/invalid input value for enum finora\.transaction_kind/);
    await expect(db.query("SELECT refunds_transaction_id FROM finora.transactions LIMIT 1")).rejects.toThrow(
      /column "refunds_transaction_id" does not exist/,
    );

    const before = await dataSnapshot(db);
    const functionsBefore = await functionCatalog(db);
    const triggersBefore = await triggerCatalog(db);
    const constraintsBefore = await constraintCatalog(db);
    const grantsBefore = await transactionGrants(db);
    expect(constraintsBefore.find((c) => c.conname === "transactions_shape")!.def).not.toMatch(/card_refund/);

    deployMigrations(scratch.url); // the real project migrations, as on a deployment

    expect(await migrationRows(db, CARD_REFUND_KIND)).toEqual([{ finished: true, rolled_back: false }]);
    expect(await migrationRows(db, CARD_REFUNDS)).toEqual([{ finished: true, rolled_back: false }]);
    // No row is written or rewritten (the new column is NULL everywhere), and
    // no trigger is added, removed or rewired.
    const after = await dataSnapshot(db);
    const withoutLink = (rows: unknown[]) => rows.map((row) => ({ ...(row as Record<string, unknown>), refunds_transaction_id: undefined }));
    const afterTransactions = after["transactions"] ?? [];
    expect(withoutLink(afterTransactions)).toEqual(withoutLink(before["transactions"] ?? []));
    expect((afterTransactions as { refunds_transaction_id: string | null }[]).every((r) => r.refunds_transaction_id === null)).toBe(true);
    for (const table of Object.keys(before).filter((t) => t !== "transactions")) expect(after[table]).toEqual(before[table]);
    expect(afterTransactions).toHaveLength((before["transactions"] ?? []).length);
    expect(await triggerCatalog(db)).toEqual(triggersBefore);

    // Same functions with the same attributes, owner and privileges; only the
    // three bodies this milestone replaces differ.
    const functionsAfter = await functionCatalog(db);
    const withoutBody = (rows: { proname: string; body: string }[]) => rows.map((row) => ({ ...row, body: undefined }));
    expect(withoutBody(functionsAfter)).toEqual(withoutBody(functionsBefore));
    expect(functionsAfter.filter((f, i) => f.body !== functionsBefore[i]!.body).map((f) => f.proname)).toEqual([
      "assert_transaction_valid",
      "transactions_insert_guard",
      "transactions_update_guard",
    ]);

    // transactions_shape changed and is validated (so every existing row
    // satisfies it); the two new constraints are the only ones added.
    const constraintsAfter = await constraintCatalog(db);
    expect(constraintsAfter.filter((c) => !constraintsBefore.some((b) => b.conname === c.conname)).map((c) => c.conname)).toEqual([
      "transactions_refund_link",
      "transactions_refunds_fkey",
    ]);
    expect(constraintsBefore.filter((b) => !constraintsAfter.some((c) => c.conname === b.conname))).toEqual([]);
    expect(
      constraintsAfter
        .filter((c) => constraintsBefore.some((b) => b.conname === c.conname && b.def !== c.def))
        .map((c) => c.conname),
    ).toEqual(["transactions_shape"]);
    for (const name of ["transactions_shape", "transactions_refund_link", "transactions_refunds_fkey"]) {
      expect(constraintsAfter.find((c) => c.conname === name)!.convalidated).toBe(true);
    }
    const shapeAfter = constraintsAfter.find((c) => c.conname === "transactions_shape")!;
    expect(shapeAfter.def).toMatch(/card_refund/);
    expect(shapeAfter.def).toMatch(/ELSE false/i);
    // The index that keeps "how much is refunded" cheap.
    const { rows: indexes } = await db.query(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'finora' AND tablename = 'transactions' AND indexname = 'transactions_refunds_idx'",
    );
    expect(indexes).toHaveLength(1);

    // The enum gained exactly one value, at the end.
    const kinds = await db.query("SELECT unnest(enum_range(NULL::finora.transaction_kind))::text AS kind");
    expect(kinds.rows.map((r) => r.kind)).toEqual(["opening_balance", "income", "expense", "transfer", "card_payment", "card_refund"]);

    // The runtime role can read and insert the new column but never update it.
    const grantsAfter = await transactionGrants(db);
    expect(grantsAfter["refunds_transaction_id"]).toBe("INSERT,SELECT");
    for (const column of Object.keys(grantsBefore)) expect(grantsAfter[column]).toBe(grantsBefore[column]);

    // And now a refund works, reducing the amount owed.
    expect((await finance.getAccount(owner, card.id)).balance.toDecimalString()).toBe("8250.00");
    const refund = await finance.recordTransaction(owner, {
      kind: "card_refund",
      amount: "1250",
      date: today,
      destinationAccountId: card.id,
      refundsTransactionId: purchase.id,
      idempotencyKey: randomUUID(),
    });
    expect(await lines(db, refund.value.journalEntryId)).toEqual([
      ["liability", "debit", "125000", "INR"],
      ["expense", "credit", "125000", "INR"],
    ]);
    expect((await finance.getAccount(owner, card.id)).balance.toDecimalString()).toBe("7000.00");
  }, 180_000);
});

describe("card refunds (migrated scratch database)", () => {
  let scratch: ScratchDatabase;
  let db: pg.Client;
  let app: pg.Client;
  let finance: ReturnType<typeof financeFor>;
  let prisma: Parameters<typeof authorize>[0];

  beforeAll(async () => {
    scratch = await scratchDatabase("cardrefund");
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
  /** A card purchase through the service. */
  const spend = (owner: AuthorizedOwner, cardId: string, categoryId: string, amount = "1250", extra: Record<string, unknown> = {}) =>
    finance.recordTransaction(owner, { kind: "expense", amount, date: today, sourceAccountId: cardId, categoryId, idempotencyKey: randomUUID(), ...extra });
  const refund = (owner: AuthorizedOwner, extra: Record<string, unknown>) =>
    finance.recordTransaction(owner, { kind: "card_refund", amount: "500", date: today, idempotencyKey: randomUUID(), ...extra });
  /** The ledger account a category posts to in `currency` (created on first use). */
  const categoryLedger = async (categoryId: string, currency = "INR") =>
    (
      await db.query("SELECT ledger_account_id::text AS id FROM finora.category_ledger_accounts WHERE category_id = $1 AND currency_code = $2", [
        categoryId,
        currency,
      ])
    ).rows[0].id as string;

  describe("service", () => {
    it("posts Dr the card / Cr the expense category, so the amount owed and that category's expenses both fall", async () => {
      const { seeded, owner, named } = await fresh();
      const hdfc = await card(owner, "Refund card", { openingBalance: { amount: "12000", date: "2026-10-01" } });
      const shopping = named("Shopping").id;
      const purchase = (await spend(owner, hdfc.id, shopping, "1250", { payee: "Bata" })).value;
      const shoppingLedger = await categoryLedger(shopping);
      expect(await normalBalance(db, shoppingLedger)).toBe(125_000n); // the purchase, as an expense
      expect(await balanceOf(owner, hdfc.id)).toBe("13250.00");
      const before = await counts(db, seeded.ownerId);

      const { value: back, replayed } = await refund(owner, {
        amount: "1250.00",
        date: "2026-10-26",
        destinationAccountId: hdfc.id,
        refundsTransactionId: purchase.id,
        payee: "Bata",
        note: "Returned the shoes",
      });
      expect(replayed).toBe(false);
      expect(back).toMatchObject({
        kind: "card_refund",
        occurredOn: "2026-10-26",
        sourceAccountId: null,
        destinationAccountId: hdfc.id,
        // The category is taken from the purchase, not from the request.
        categoryId: shopping,
        refundsTransactionId: purchase.id,
        payee: "Bata",
        note: "Returned the shoes",
        voidedAt: null,
      });
      expect(back.amount.toDecimalString()).toBe("1250.00");

      // Exactly the mirror of the purchase's entry, and exactly two lines.
      expect(await entryAccounts(db, back.journalEntryId)).toEqual([
        [hdfc.ledgerAccountId, "debit", "125000"],
        [shoppingLedger, "credit", "125000"],
      ]);
      // The amount owed is back to the opening amount and the category's
      // expenses are back to zero: a refund reduces expenses.
      expect(await balanceOf(owner, hdfc.id)).toBe("12000.00");
      expect(await normalBalance(db, shoppingLedger)).toBe(0n);
      // One transaction, one entry, two lines.
      expect(await counts(db, seeded.ownerId)).toEqual({
        transactions: before.transactions + 1,
        entries: before.entries + 1,
        lines: before.lines + 2,
      });
      // The purchase's own entry is untouched.
      expect(await entryAccounts(db, purchase.journalEntryId)).toEqual([
        [shoppingLedger, "debit", "125000"],
        [hdfc.ledgerAccountId, "credit", "125000"],
      ]);
    });

    it("never adds income: no income account is touched and income totals do not move", async () => {
      const { owner, named } = await fresh();
      const hdfc = await card(owner, "No income card");
      const axis = await bank(owner, "No income bank", { openingBalance: { amount: "50000", date: today } });
      const salary = named("Salary").id;
      await finance.recordTransaction(owner, { kind: "income", amount: "1000", date: today, destinationAccountId: axis.id, categoryId: salary, idempotencyKey: randomUUID() });
      const salaryLedger = await categoryLedger(salary);
      const incomeBefore = await normalBalance(db, salaryLedger);

      const purchase = (await spend(owner, hdfc.id, named("Shopping").id)).value;
      const back = (await refund(owner, { amount: "1250", destinationAccountId: hdfc.id, refundsTransactionId: purchase.id })).value;

      expect(await normalBalance(db, salaryLedger)).toBe(incomeBefore);
      // The refund's two lines are a liability and an expense account; no
      // income account anywhere.
      const { rows } = await db.query(
        `SELECT DISTINCT la.kind::text AS kind FROM finora.journal_lines l
           JOIN finora.ledger_accounts la ON la.id = l.account_id WHERE l.entry_id = $1 ORDER BY 1`,
        [back.journalEntryId],
      );
      expect(rows.map((r) => r.kind)).toEqual(["expense", "liability"]);
      // And it is never listed as income.
      expect((await finance.listTransactions(owner, { kind: "income" })).map((t) => t.id)).not.toContain(back.id);
      expect((await finance.listTransactions(owner, { kind: "card_refund" })).map((t) => t.id)).toEqual([back.id]);
    });

    it("supports several partial refunds that together come to exactly the purchase", async () => {
      const { owner, named } = await fresh();
      const hdfc = await card(owner, "Partial card");
      const shopping = named("Shopping").id;
      const purchase = (await spend(owner, hdfc.id, shopping, "1250")).value;
      const shoppingLedger = await categoryLedger(shopping);

      for (const amount of ["500", "250.50", "499.50"]) {
        await refund(owner, { amount, destinationAccountId: hdfc.id, refundsTransactionId: purchase.id });
      }
      // The purchase is refunded in full, to the minor unit.
      const summary = (await finance.getPurchaseRefunds(owner, purchase.id))!;
      expect(summary.refunded.toDecimalString()).toBe("1250.00");
      expect(summary.remaining.toDecimalString()).toBe("0.00");
      expect(summary.refunds).toHaveLength(3);
      expect(await normalBalance(db, shoppingLedger)).toBe(0n);
      expect(await balanceOf(owner, hdfc.id)).toBe("0.00");
      // Nothing is left to refund, so it is no longer offered.
      expect((await finance.listRefundablePurchases(owner)).map((r) => r.purchase.id)).not.toContain(purchase.id);
    });

    it("refuses a refund that would take the total past what was paid, writing nothing", async () => {
      const { seeded, owner, named } = await fresh();
      const hdfc = await card(owner, "Cap card");
      const purchase = (await spend(owner, hdfc.id, named("Shopping").id, "1250")).value;
      await refund(owner, { amount: "1000", destinationAccountId: hdfc.id, refundsTransactionId: purchase.id });
      const before = await counts(db, seeded.ownerId);

      // One minor unit too many.
      await expect(refund(owner, { amount: "250.01", destinationAccountId: hdfc.id, refundsTransactionId: purchase.id })).rejects.toThrow(
        /Refund at most 250\.00 INR/,
      );
      await expect(refund(owner, { amount: "1250", destinationAccountId: hdfc.id, refundsTransactionId: purchase.id })).rejects.toThrow(
        /Refund at most 250\.00 INR/,
      );
      expect(await counts(db, seeded.ownerId)).toEqual(before);
      // Exactly what is left still fits.
      await refund(owner, { amount: "250", destinationAccountId: hdfc.id, refundsTransactionId: purchase.id });
      // And then nothing more does.
      await expect(refund(owner, { amount: "0.01", destinationAccountId: hdfc.id, refundsTransactionId: purchase.id })).rejects.toThrow(
        /already been refunded in full/,
      );
    });

    it("refuses an ineligible purchase: another card's, a bank purchase, a voided one, a refund, a payment", async () => {
      const { seeded, owner, named } = await fresh();
      const hdfc = await card(owner, "Elig card");
      const amex = await card(owner, "Elig card 2");
      const axis = await bank(owner, "Elig bank", { openingBalance: { amount: "50000", date: today } });
      const shopping = named("Shopping").id;
      const onOtherCard = (await spend(owner, amex.id, shopping)).value;
      const onBank = (await finance.recordTransaction(owner, { kind: "expense", amount: "300", date: today, sourceAccountId: axis.id, categoryId: shopping, idempotencyKey: randomUUID() })).value;
      const voided = (await spend(owner, hdfc.id, shopping, "400")).value;
      await finance.voidTransaction(owner, voided.id, { date: today, idempotencyKey: randomUUID() });
      const good = (await spend(owner, hdfc.id, shopping, "1250")).value;
      const aRefund = (await refund(owner, { amount: "100", destinationAccountId: hdfc.id, refundsTransactionId: good.id })).value;
      const payment = (await finance.recordTransaction(owner, { kind: "card_payment", amount: "100", date: today, sourceAccountId: axis.id, destinationAccountId: hdfc.id, idempotencyKey: randomUUID() })).value;
      const before = await counts(db, seeded.ownerId);

      for (const target of [onOtherCard.id, onBank.id, voided.id, aRefund.id, payment.id]) {
        await expect(refund(owner, { amount: "50", destinationAccountId: hdfc.id, refundsTransactionId: target })).rejects.toThrow(
          /Choose a purchase paid with Elig card that has not been voided/,
        );
      }
      // A refund of a refund is refused, so no chain or cycle can be built.
      expect(await counts(db, seeded.ownerId)).toEqual(before);
      // None of the refused links were written.
      const { rows } = await db.query("SELECT count(*)::int AS n FROM finora.transactions WHERE refunds_transaction_id = ANY($1::uuid[])", [
        [onOtherCard.id, onBank.id, voided.id, aRefund.id, payment.id],
      ]);
      expect(rows[0].n).toBe(0);
    });

    it("refuses another owner's purchase, revealing nothing about it", async () => {
      const mine = await fresh();
      const theirs = await fresh();
      const myCard = await card(mine.owner, "Cross card");
      const theirCard = await card(theirs.owner, "Their card");
      const theirPurchase = (await spend(theirs.owner, theirCard.id, theirs.named("Shopping").id)).value;
      const before = await counts(db, mine.seeded.ownerId);

      // The same "not found" as any unknown id: ids reveal nothing.
      await expect(refund(mine.owner, { amount: "50", destinationAccountId: myCard.id, refundsTransactionId: theirPurchase.id })).rejects.toThrow(
        /Transaction not found/,
      );
      await expect(refund(mine.owner, { amount: "50", destinationAccountId: myCard.id, refundsTransactionId: randomUUID() })).rejects.toThrow(
        /Transaction not found/,
      );
      expect(await counts(db, mine.seeded.ownerId)).toEqual(before);
      // And their card is not a destination for me either.
      await expect(refund(mine.owner, { amount: "50", destinationAccountId: theirCard.id, refundsTransactionId: theirPurchase.id })).rejects.toThrow();
    });

    it("refuses a currency mismatch between the card and the purchase (no FX)", async () => {
      const { seeded, owner, named } = await fresh();
      const inrCard = await card(owner, "FX card INR");
      const usdCard = await card(owner, "FX card USD", { currency: "USD" });
      const shopping = named("Shopping").id;
      const usdPurchase = (await spend(owner, usdCard.id, shopping, "100")).value;
      const before = await counts(db, seeded.ownerId);
      // The purchase is in USD; refunding it onto the INR card is refused.
      await expect(refund(owner, { amount: "50", destinationAccountId: inrCard.id, refundsTransactionId: usdPurchase.id })).rejects.toThrow(
        /Choose a purchase paid with FX card INR/,
      );
      expect(await counts(db, seeded.ownerId)).toEqual(before);
      // On its own card it posts in USD, and over-precision is refused.
      await expect(refund(owner, { amount: "1.234", destinationAccountId: usdCard.id, refundsTransactionId: usdPurchase.id })).rejects.toThrow(
        /at most 2 decimal places for USD/,
      );
      const back = (await refund(owner, { amount: "40.25", destinationAccountId: usdCard.id, refundsTransactionId: usdPurchase.id })).value;
      expect(await lines(db, back.journalEntryId)).toEqual([
        ["liability", "debit", "4025", "USD"],
        ["expense", "credit", "4025", "USD"],
      ]);
    });

    it("refuses an archived card, and a bank or cash account as the refunded account", async () => {
      const { seeded, owner, named } = await fresh();
      const hdfc = await card(owner, "Arch card");
      const axis = await bank(owner, "Arch bank", { openingBalance: { amount: "5000", date: today } });
      const purchase = (await spend(owner, hdfc.id, named("Shopping").id)).value;
      const before = await counts(db, seeded.ownerId);

      await expect(refund(owner, { amount: "50", destinationAccountId: axis.id, refundsTransactionId: purchase.id })).rejects.toThrow(
        /is not a credit card; choose a credit card/,
      );
      await finance.archiveAccount(owner, hdfc.id);
      await expect(refund(owner, { amount: "50", destinationAccountId: hdfc.id, refundsTransactionId: purchase.id })).rejects.toThrow(
        /is archived; restore it to record new transactions/,
      );
      expect(await counts(db, seeded.ownerId)).toEqual(before);
      // An archived card's purchases are not offered for a refund either.
      expect((await finance.listRefundablePurchases(owner)).map((r) => r.purchase.id)).not.toContain(purchase.id);
    });

    it("replays a retried refund once, and refuses the same key for any other business field, writing nothing", async () => {
      const { seeded, owner, named } = await fresh();
      const hdfc = await card(owner, "Replay card");
      const purchase = (await spend(owner, hdfc.id, named("Shopping").id, "1250")).value;
      const key = randomUUID();
      const request = { kind: "card_refund", amount: "500", date: today, destinationAccountId: hdfc.id, refundsTransactionId: purchase.id, idempotencyKey: key };

      const first = await finance.recordTransaction(owner, request);
      expect(first.replayed).toBe(false);
      const after = await counts(db, seeded.ownerId);
      const again = await finance.recordTransaction(owner, request);
      expect(again.replayed).toBe(true);
      expect(again.value.id).toBe(first.value.id);
      // A replay does not count twice against the purchase.
      expect((await finance.getPurchaseRefunds(owner, purchase.id))!.refunded.toDecimalString()).toBe("500.00");
      expect(await counts(db, seeded.ownerId)).toEqual(after);

      // The same key for any other business field is a conflict, and writes nothing.
      for (const change of [{ amount: "501" }, { date: "2026-10-27" }, { note: "different" }, { payee: "Someone" }]) {
        await expect(finance.recordTransaction(owner, { ...request, ...change })).rejects.toThrow(IdempotencyConflictError);
      }
      expect(await counts(db, seeded.ownerId)).toEqual(after);
      expect((await finance.getPurchaseRefunds(owner, purchase.id))!.refunded.toDecimalString()).toBe("500.00");
    });

    it("replays a refund that used up the whole purchase, instead of refusing it as over the limit", async () => {
      // The replayed refund's own amount is already in the purchase's total,
      // so re-running the cumulative check would refuse a retry of a refund
      // that is perfectly valid and already recorded.
      const { seeded, owner, named } = await fresh();
      const hdfc = await card(owner, "Full replay card");
      const purchase = (await spend(owner, hdfc.id, named("Shopping").id, "1250")).value;
      const key = randomUUID();
      const request = { kind: "card_refund", amount: "1250", date: today, destinationAccountId: hdfc.id, refundsTransactionId: purchase.id, idempotencyKey: key };

      const first = await finance.recordTransaction(owner, request);
      expect(first.replayed).toBe(false);
      expect((await finance.getPurchaseRefunds(owner, purchase.id))!.remaining.toDecimalString()).toBe("0.00");
      const after = await counts(db, seeded.ownerId);

      const again = await finance.recordTransaction(owner, request);
      expect(again.replayed).toBe(true);
      expect(again.value.id).toBe(first.value.id);
      expect(await counts(db, seeded.ownerId)).toEqual(after);
      expect((await finance.getPurchaseRefunds(owner, purchase.id))!.refunded.toDecimalString()).toBe("1250.00");

      // A different request on that key is still a conflict, not a second refund.
      await expect(finance.recordTransaction(owner, { ...request, amount: "100" })).rejects.toThrow(IdempotencyConflictError);
      expect(await counts(db, seeded.ownerId)).toEqual(after);
      // And a NEW key for any further refund is still refused by the limit.
      await expect(refund(owner, { amount: "0.01", destinationAccountId: hdfc.id, refundsTransactionId: purchase.id })).rejects.toThrow(
        /already been refunded in full/,
      );
    });

    it("voids a refund with its exact mirror, giving the refundable amount back without editing posted lines", async () => {
      const { owner, named } = await fresh();
      const hdfc = await card(owner, "Void card");
      const shopping = named("Shopping").id;
      const purchase = (await spend(owner, hdfc.id, shopping, "1250")).value;
      const shoppingLedger = await categoryLedger(shopping);
      const back = (await refund(owner, { amount: "1250", destinationAccountId: hdfc.id, refundsTransactionId: purchase.id })).value;
      expect(await normalBalance(db, shoppingLedger)).toBe(0n);
      const postedLines = await entryAccounts(db, back.journalEntryId);

      const voided = await finance.voidTransaction(owner, back.id, { date: "2026-10-27", idempotencyKey: randomUUID() });
      expect(voided.value.voidedAt).not.toBeNull();
      // The refund's own entry is untouched; the reversal is a new entry.
      expect(await entryAccounts(db, back.journalEntryId)).toEqual(postedLines);
      // A reversal keeps the original's line order and flips each side.
      expect(await entryAccounts(db, voided.value.reversalEntryId!)).toEqual([
        [hdfc.ledgerAccountId, "credit", "125000"],
        [shoppingLedger, "debit", "125000"],
      ]);
      // The expense is back and so is the amount owed.
      expect(await normalBalance(db, shoppingLedger)).toBe(125_000n);
      expect(await balanceOf(owner, hdfc.id)).toBe("1250.00");

      // The refundable amount came back, and the purchase takes a refund again.
      const summary = (await finance.getPurchaseRefunds(owner, purchase.id))!;
      expect(summary.refunded.toDecimalString()).toBe("0.00");
      expect(summary.remaining.toDecimalString()).toBe("1250.00");
      // The voided refund is still in history, linked to the purchase.
      expect(summary.refunds.map((r) => r.id)).toEqual([back.id]);
      await refund(owner, { amount: "1250", destinationAccountId: hdfc.id, refundsTransactionId: purchase.id });
      expect((await finance.getPurchaseRefunds(owner, purchase.id))!.remaining.toDecimalString()).toBe("0.00");
    });

    it("refuses to void a purchase that still has refunds, and allows it once they are voided", async () => {
      const { owner, named } = await fresh();
      const hdfc = await card(owner, "Order card");
      const purchase = (await spend(owner, hdfc.id, named("Shopping").id, "1250")).value;
      const back = (await refund(owner, { amount: "500", destinationAccountId: hdfc.id, refundsTransactionId: purchase.id })).value;

      await expect(finance.voidTransaction(owner, purchase.id, { date: today, idempotencyKey: randomUUID() })).rejects.toThrow(
        FinanceConflictError,
      );
      expect((await finance.getTransaction(owner, purchase.id)).voidedAt).toBeNull();

      await finance.voidTransaction(owner, back.id, { date: today, idempotencyKey: randomUUID() });
      const voidedPurchase = await finance.voidTransaction(owner, purchase.id, { date: today, idempotencyKey: randomUUID() });
      expect(voidedPurchase.value.voidedAt).not.toBeNull();
      // Editing the voided refund's note still works: it is allowed to point
      // at a purchase that was voided after it.
      await finance.updateTransactionDetails(owner, back.id, { payee: "Bata", note: "cancelled" });
      expect(await finance.getTransaction(owner, back.id)).toMatchObject({ payee: "Bata", note: "cancelled" });
    });

    describe("unlinked refunds (a merchant credit for a purchase Finora never recorded)", () => {
      it("debits the card and credits the chosen expense category, with no purchase link", async () => {
        const { owner, named } = await fresh();
        const hdfc = await card(owner, "Unlinked card", { openingBalance: { amount: "3000", date: "2026-10-01" } });
        const health = named("Health").id;
        const back = (await refund(owner, { amount: "400", destinationAccountId: hdfc.id, categoryId: health, payee: "Chemist" })).value;

        expect(back).toMatchObject({ kind: "card_refund", categoryId: health, refundsTransactionId: null, payee: "Chemist" });
        expect(await entryAccounts(db, back.journalEntryId)).toEqual([
          [hdfc.ledgerAccountId, "debit", "40000"],
          [await categoryLedger(health), "credit", "40000"],
        ]);
        // The amount owed falls, and that category's expenses go negative:
        // money came back for spending Finora never saw.
        expect(await balanceOf(owner, hdfc.id)).toBe("2600.00");
        expect(await normalBalance(db, await categoryLedger(health))).toBe(-40_000n);
      });

      it("refuses an income category, so a merchant credit can never be filed as income", async () => {
        const { seeded, owner, named } = await fresh();
        const hdfc = await card(owner, "Unlinked income card");
        const before = await counts(db, seeded.ownerId);
        for (const name of ["Salary", "Interest", "Other income"]) {
          await expect(refund(owner, { amount: "400", destinationAccountId: hdfc.id, categoryId: named(name).id })).rejects.toThrow(
            /Choose an expense category/,
          );
        }
        expect(await counts(db, seeded.ownerId)).toEqual(before);
      });

      it("is not counted against any purchase's refundable amount", async () => {
        const { owner, named } = await fresh();
        const hdfc = await card(owner, "Separate card");
        const shopping = named("Shopping").id;
        const purchase = (await spend(owner, hdfc.id, shopping, "1250")).value;
        // An unlinked refund in the SAME category and on the same card.
        await refund(owner, { amount: "900", destinationAccountId: hdfc.id, categoryId: shopping });

        const summary = (await finance.getPurchaseRefunds(owner, purchase.id))!;
        expect(summary.refunded.toDecimalString()).toBe("0.00");
        expect(summary.remaining.toDecimalString()).toBe("1250.00");
        // So the purchase can still be refunded in full afterwards.
        await refund(owner, { amount: "1250", destinationAccountId: hdfc.id, refundsTransactionId: purchase.id });
        expect((await finance.getPurchaseRefunds(owner, purchase.id))!.refunded.toDecimalString()).toBe("1250.00");
        // Both refunds exist; only the linked one carries a link.
        const { rows } = await db.query(
          "SELECT count(*)::int AS n, count(refunds_transaction_id)::int AS linked FROM finora.transactions WHERE kind = 'card_refund' AND destination_account_id = $1",
          [hdfc.id],
        );
        expect(rows[0]).toEqual({ n: 2, linked: 1 });
      });

      it("leaves a card with a credit balance in the owner's favour when it exceeds what is owed", async () => {
        const { owner, named } = await fresh();
        const hdfc = await card(owner, "Credit balance card");
        // Nothing owed at all, then a merchant credit.
        expect(await balanceOf(owner, hdfc.id)).toBe("0.00");
        await refund(owner, { amount: "750", destinationAccountId: hdfc.id, categoryId: named("Shopping").id });
        // Negative normal balance: a credit in the owner's favour, exactly as
        // an overpayment leaves one (ADR 0008, Milestone 5C).
        expect(await balanceOf(owner, hdfc.id)).toBe("-750.00");
        // And it can then be spent down again.
        await spend(owner, hdfc.id, named("Shopping").id, "250");
        expect(await balanceOf(owner, hdfc.id)).toBe("-500.00");
      });
    });

    it("offers only eligible purchases, with the amount left on each", async () => {
      const { owner, named } = await fresh();
      const hdfc = await card(owner, "Offer card");
      const axis = await bank(owner, "Offer bank", { openingBalance: { amount: "50000", date: today } });
      const shopping = named("Shopping").id;
      const open = (await spend(owner, hdfc.id, shopping, "1250")).value;
      const partly = (await spend(owner, hdfc.id, shopping, "800")).value;
      await refund(owner, { amount: "300", destinationAccountId: hdfc.id, refundsTransactionId: partly.id });
      const full = (await spend(owner, hdfc.id, shopping, "100")).value;
      await refund(owner, { amount: "100", destinationAccountId: hdfc.id, refundsTransactionId: full.id });
      const voided = (await spend(owner, hdfc.id, shopping, "60")).value;
      await finance.voidTransaction(owner, voided.id, { date: today, idempotencyKey: randomUUID() });
      await finance.recordTransaction(owner, { kind: "expense", amount: "70", date: today, sourceAccountId: axis.id, categoryId: shopping, idempotencyKey: randomUUID() });

      const offered = await finance.listRefundablePurchases(owner);
      expect(offered.map((r) => [r.purchase.id, r.remaining.toDecimalString()])).toEqual([
        [partly.id, "500.00"],
        [open.id, "1250.00"],
      ]);
      // Fully refunded, voided and non-card purchases are all left out.
      const ids = offered.map((r) => r.purchase.id);
      expect(ids).not.toContain(full.id);
      expect(ids).not.toContain(voided.id);
    });

    it("reports no refund summary for anything that is not a card purchase", async () => {
      const { owner, named } = await fresh();
      const hdfc = await card(owner, "Summary card");
      const axis = await bank(owner, "Summary bank", { openingBalance: { amount: "50000", date: today } });
      const bankExpense = (await finance.recordTransaction(owner, { kind: "expense", amount: "70", date: today, sourceAccountId: axis.id, categoryId: named("Shopping").id, idempotencyKey: randomUUID() })).value;
      const payment = (await finance.recordTransaction(owner, { kind: "card_payment", amount: "70", date: today, sourceAccountId: axis.id, destinationAccountId: hdfc.id, idempotencyKey: randomUUID() })).value;
      const back = (await refund(owner, { amount: "50", destinationAccountId: hdfc.id, categoryId: named("Shopping").id })).value;
      for (const id of [bankExpense.id, payment.id, back.id]) expect(await finance.getPurchaseRefunds(owner, id)).toBeNull();
      // And a card purchase does report one, even with no refunds yet.
      const purchase = (await spend(owner, hdfc.id, named("Shopping").id, "1250")).value;
      expect((await finance.getPurchaseRefunds(owner, purchase.id))!.remaining.toDecimalString()).toBe("1250.00");
    });

    it("keeps a refund's payee and note editable without touching the journal", async () => {
      const { owner, named } = await fresh();
      const hdfc = await card(owner, "Note card");
      const purchase = (await spend(owner, hdfc.id, named("Shopping").id)).value;
      const back = (await refund(owner, { amount: "100", destinationAccountId: hdfc.id, refundsTransactionId: purchase.id, payee: "Bata", note: "first" })).value;
      const before = await entryAccounts(db, back.journalEntryId);
      const { rows: descriptionBefore } = await db.query("SELECT description FROM finora.journal_entries WHERE id = $1", [back.journalEntryId]);

      await finance.updateTransactionDetails(owner, back.id, { payee: "Bata India", note: "second" });
      expect(await finance.getTransaction(owner, back.id)).toMatchObject({ payee: "Bata India", note: "second" });
      expect(await entryAccounts(db, back.journalEntryId)).toEqual(before);
      // The journal keeps its original text.
      expect((await db.query("SELECT description FROM finora.journal_entries WHERE id = $1", [back.journalEntryId])).rows).toEqual(descriptionBefore);
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
    let usdCardId: string;
    let shoppingId: string;
    let shoppingLedger: string;
    let salaryId: string;
    let salaryLedger: string;
    /** A ₹1,250.00 purchase on cardId with nothing refunded. */
    let purchaseId: string;
    /** A purchase on card2Id, and one in USD. */
    let otherCardPurchaseId: string;
    let usdPurchaseId: string;
    let bankPurchaseId: string;
    let paymentId: string;
    let otherOwnerPurchaseId: string;

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
      refunds?: string | null;
      entry: string;
      currency?: string;
    }) =>
      app.query(
        `INSERT INTO finora.transactions (owner_id, kind, occurred_on, amount_minor, currency_code,
           source_account_id, destination_account_id, category_id, refunds_transaction_id, journal_entry_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          ownerId,
          row.kind,
          today,
          row.amount,
          row.currency ?? "INR",
          row.source ?? null,
          row.destination ?? null,
          row.category ?? null,
          row.refunds ?? null,
          row.entry,
        ],
      );
    const asTheOwner = <T>(work: () => Promise<T>) => asOwner(app, ownerId, work);
    /** A raw linked refund of `purchaseId` for `amount` minor units. */
    const rawRefund = (amount: number, refunds: string | null = purchaseId, destination = cardId, category = shoppingId, ledger = cardLedger, counter = shoppingLedger, currency = "INR") =>
      asTheOwner(async () =>
        insert({ kind: "card_refund", amount, destination, category, refunds, currency, entry: await postedEntry(ledger, counter, amount, currency) }),
      );
    const refundsOn = async (id: string) =>
      (await db.query("SELECT count(*)::int AS n FROM finora.transactions WHERE refunds_transaction_id = $1", [id])).rows[0].n as number;
    const refundedOn = async (id: string) =>
      BigInt(
        (
          await db.query(
            "SELECT coalesce(sum(amount_minor), 0)::text AS t FROM finora.transactions WHERE refunds_transaction_id = $1 AND voided_at IS NULL",
            [id],
          )
        ).rows[0].t,
      );

    beforeAll(async () => {
      const { seeded, owner, named } = await fresh();
      const other = await fresh();
      ownerId = seeded.ownerId;
      const hdfc = await card(owner, "Raw refund card");
      const icici = await card(owner, "Raw refund card 2");
      const axis = await bank(owner, "Raw refund bank", { openingBalance: { amount: "100000", date: today } });
      const usd = await card(owner, "Raw refund USD card", { currency: "USD" });
      [cardId, cardLedger, card2Id, card2Ledger] = [hdfc.id, hdfc.ledgerAccountId, icici.id, icici.ledgerAccountId];
      [bankId, bankLedger, usdCardId] = [axis.id, axis.ledgerAccountId, usd.id];
      shoppingId = named("Shopping").id;
      salaryId = named("Salary").id;
      // Through the application, so every category ledger account exists.
      purchaseId = (await spend(owner, cardId, shoppingId, "1250")).value.id;
      otherCardPurchaseId = (await spend(owner, card2Id, shoppingId, "900")).value.id;
      usdPurchaseId = (await spend(owner, usdCardId, shoppingId, "100")).value.id;
      bankPurchaseId = (await finance.recordTransaction(owner, { kind: "expense", amount: "70", date: today, sourceAccountId: bankId, categoryId: shoppingId, idempotencyKey: randomUUID() })).value.id;
      paymentId = (await finance.recordTransaction(owner, { kind: "card_payment", amount: "70", date: today, sourceAccountId: bankId, destinationAccountId: cardId, idempotencyKey: randomUUID() })).value.id;
      await finance.recordTransaction(owner, { kind: "income", amount: "10", date: today, destinationAccountId: bankId, categoryId: salaryId, idempotencyKey: randomUUID() });
      shoppingLedger = await categoryLedger(shoppingId);
      salaryLedger = await categoryLedger(salaryId);
      const theirCard = await card(other.owner, "Their raw card");
      otherOwnerPurchaseId = (await spend(other.owner, theirCard.id, other.named("Shopping").id)).value.id;
    }, 120_000);

    it("accepts a refund whose entry is exactly Dr the card / Cr the category, linked or not", async () => {
      const before = await refundsOn(purchaseId);
      await rawRefund(10_000);
      // And an unlinked one.
      await asTheOwner(async () =>
        insert({ kind: "card_refund", amount: 2_500, destination: cardId, category: shoppingId, entry: await postedEntry(cardLedger, shoppingLedger, 2_500) }),
      );
      expect(await refundsOn(purchaseId)).toBe(before + 1);
    });

    it.each([
      ["the wrong direction (Dr the category / Cr the card)", () => ({ debit: () => shoppingLedger, credit: () => cardLedger, entryAmount: 500, amount: 500 })],
      ["another card's liability account", () => ({ debit: () => card2Ledger, credit: () => shoppingLedger, entryAmount: 500, amount: 500 })],
      ["the paying bank account instead of the category", () => ({ debit: () => cardLedger, credit: () => bankLedger, entryAmount: 500, amount: 500 })],
      ["an income account instead of the expense category", () => ({ debit: () => cardLedger, credit: () => salaryLedger, entryAmount: 500, amount: 500 })],
      ["a different amount", () => ({ debit: () => cardLedger, credit: () => shoppingLedger, entryAmount: 500, amount: 501 })],
    ])("refuses a refund whose entry has %s", async (_label, parts) => {
      const { debit, credit, entryAmount, amount } = parts();
      const before = await refundsOn(purchaseId);
      await expect(
        asTheOwner(async () =>
          insert({ kind: "card_refund", amount, destination: cardId, category: shoppingId, refunds: purchaseId, entry: await postedEntry(debit(), credit(), entryAmount) }),
        ),
      ).rejects.toThrow(/the journal entry does not match the transaction|the category kind does not match the transaction/);
      expect(await refundsOn(purchaseId)).toBe(before);
    });

    it("refuses a bank or cash account as the refunded account, even with a matching entry", async () => {
      await expect(
        asTheOwner(async () =>
          insert({ kind: "card_refund", amount: 700, destination: bankId, category: shoppingId, entry: await postedEntry(bankLedger, shoppingLedger, 700) }),
        ),
      ).rejects.toThrow(NOT_A_CARD);
    });

    it("refuses a refund with a source account, no card, or no category (the row CHECKs and insert guard)", async () => {
      await expect(
        asTheOwner(async () =>
          insert({ kind: "card_refund", amount: 500, source: bankId, destination: cardId, category: shoppingId, entry: await postedEntry(cardLedger, shoppingLedger, 500) }),
        ),
      ).rejects.toThrow(/transactions_shape/);
      await expect(
        asTheOwner(async () => insert({ kind: "card_refund", amount: 500, destination: null, category: shoppingId, entry: await postedEntry(cardLedger, shoppingLedger, 500) })),
      ).rejects.toThrow(/transactions_shape/);
      await expect(
        asTheOwner(async () => insert({ kind: "card_refund", amount: 500, destination: cardId, category: null, entry: await postedEntry(cardLedger, shoppingLedger, 500) })),
      ).rejects.toThrow(/transactions_shape/);
      // An income category is refused by the insert guard (BEFORE triggers run
      // before row CHECKs), so a refund can never be filed as income.
      await expect(
        asTheOwner(async () => insert({ kind: "card_refund", amount: 500, destination: cardId, category: salaryId, entry: await postedEntry(cardLedger, salaryLedger, 500) })),
      ).rejects.toThrow(/the category kind does not match the transaction/);
    });

    it.each([
      ["a card payment", () => paymentId],
      ["an expense paid from a bank account", () => bankPurchaseId],
      ["a purchase on another card", () => otherCardPurchaseId],
      ["a purchase in another currency", () => usdPurchaseId],
    ])("refuses a link to %s", async (_label, target) => {
      const id = target();
      const before = await refundsOn(id);
      await expect(rawRefund(500, id)).rejects.toThrow(INELIGIBLE);
      expect(await refundsOn(id)).toBe(before);
    });

    it("refuses a link to another refund, and to itself, so no chain or cycle can exist", async () => {
      // A refund of a refund.
      const { rows } = await db.query(
        "SELECT id::text AS id FROM finora.transactions WHERE kind = 'card_refund' AND refunds_transaction_id IS NOT NULL AND owner_id = $1 LIMIT 1",
        [ownerId],
      );
      await expect(rawRefund(100, rows[0].id)).rejects.toThrow(INELIGIBLE);
      // A row that refunds itself is refused by the row CHECK.
      await expect(
        asTheOwner(async () => {
          const id = randomUUID();
          const entry = await postedEntry(cardLedger, shoppingLedger, 100);
          return app.query(
            `INSERT INTO finora.transactions (id, owner_id, kind, occurred_on, amount_minor, currency_code,
               destination_account_id, category_id, refunds_transaction_id, journal_entry_id)
             VALUES ($1, $2, 'card_refund', $3, 100, 'INR', $4, $5, $1, $6)`,
            [id, ownerId, today, cardId, shoppingId, entry],
          );
        }),
      ).rejects.toThrow(/transactions_refund_link/);
    });

    it("refuses a purchase link on any kind other than a refund (the row CHECK)", async () => {
      await expect(
        asTheOwner(async () =>
          insert({ kind: "expense", amount: 500, source: cardId, category: shoppingId, refunds: purchaseId, entry: await postedEntry(shoppingLedger, cardLedger, 500) }),
        ),
      ).rejects.toThrow(/transactions_refund_link/);
      await expect(
        asTheOwner(async () =>
          insert({ kind: "card_payment", amount: 500, source: bankId, destination: cardId, refunds: purchaseId, entry: await postedEntry(cardLedger, bankLedger, 500) }),
        ),
      ).rejects.toThrow(/transactions_refund_link/);
      await expect(
        asTheOwner(async () =>
          insert({ kind: "income", amount: 500, destination: bankId, category: salaryId, refunds: purchaseId, entry: await postedEntry(bankLedger, salaryLedger, 500) }),
        ),
      ).rejects.toThrow(/transactions_refund_link/);
    });

    it("refuses another owner's purchase as the link (the composite foreign key)", async () => {
      const before = await refundsOn(otherOwnerPurchaseId);
      await expect(rawRefund(500, otherOwnerPurchaseId)).rejects.toThrow(/transactions_refunds_fkey|violates foreign key constraint/);
      expect(await refundsOn(otherOwnerPurchaseId)).toBe(before);
      // And an id that exists nowhere is refused the same way.
      await expect(rawRefund(500, randomUUID())).rejects.toThrow(/transactions_refunds_fkey|violates foreign key constraint/);
    });

    it("refuses raw refunds whose total would pass what was paid, to the minor unit", async () => {
      // A dedicated purchase so the running total is known exactly.
      const { owner, named } = await fresh();
      const theirOwnerId = ownerId;
      expect(theirOwnerId).toBe(ownerId);
      const capCard = await card(owner, "Raw cap card");
      const capPurchase = (await spend(owner, capCard.id, named("Shopping").id, "100")).value;
      // That owner's rows, written raw as that owner.
      const capOwner = (await db.query("SELECT owner_id::text AS id FROM finora.transactions WHERE id = $1", [capPurchase.id])).rows[0].id as string;
      const capLedger = capCard.ledgerAccountId;
      const capCategory = named("Shopping").id;
      const capCounter = (
        await db.query("SELECT ledger_account_id::text AS id FROM finora.category_ledger_accounts WHERE category_id = $1 AND currency_code = 'INR'", [capCategory])
      ).rows[0].id as string;

      const raw = (amount: number) =>
        asOwner(app, capOwner, async () => {
          const { rows } = await app.query(
            "INSERT INTO finora.journal_entries (owner_id, entry_date, description) VALUES ($1, $2, 'raw cap') RETURNING id::text",
            [capOwner, today],
          );
          await app.query(
            `INSERT INTO finora.journal_lines (owner_id, entry_id, line_no, account_id, currency_code, side, amount_minor)
             VALUES ($1, $2, 1, $3, 'INR', 'debit', $5), ($1, $2, 2, $4, 'INR', 'credit', $5)`,
            [capOwner, rows[0].id, capLedger, capCounter, amount],
          );
          await app.query("UPDATE finora.journal_entries SET status = 'posted' WHERE id = $1", [rows[0].id]);
          return app.query(
            `INSERT INTO finora.transactions (owner_id, kind, occurred_on, amount_minor, currency_code,
               destination_account_id, category_id, refunds_transaction_id, journal_entry_id)
             VALUES ($1, 'card_refund', $2, $3, 'INR', $4, $5, $6, $7)`,
            [capOwner, today, amount, capCard.id, capCategory, capPurchase.id, rows[0].id],
          );
        });

      await expect(raw(10_001)).rejects.toThrow(OVER_REFUNDED); // ₹100.01 of a ₹100.00 purchase
      expect(await refundedOn(capPurchase.id)).toBe(0n);
      await raw(6_000);
      await expect(raw(4_001)).rejects.toThrow(OVER_REFUNDED);
      expect(await refundedOn(capPurchase.id)).toBe(6_000n);
      await raw(4_000); // exactly what is left
      expect(await refundedOn(capPurchase.id)).toBe(10_000n);
      await expect(raw(1)).rejects.toThrow(OVER_REFUNDED);

      // Voiding one gives the room back, raw SQL included.
      const refundToVoid = (await db.query("SELECT id::text AS id FROM finora.transactions WHERE refunds_transaction_id = $1 AND amount_minor = 4000", [capPurchase.id])).rows[0].id as string;
      await finance.voidTransaction(owner, refundToVoid, { date: today, idempotencyKey: randomUUID() });
      expect(await refundedOn(capPurchase.id)).toBe(6_000n);
      await raw(4_000);
      expect(await refundedOn(capPurchase.id)).toBe(10_000n);
    });

    it("refuses voiding a purchase that still has an active refund, at COMMIT", async () => {
      const { owner, named } = await fresh();
      const voidCard = await card(owner, "Raw void card");
      const purchase = (await spend(owner, voidCard.id, named("Shopping").id, "500")).value;
      const back = (await refund(owner, { amount: "200", destinationAccountId: voidCard.id, refundsTransactionId: purchase.id })).value;
      const voidOwner = (await db.query("SELECT owner_id::text AS id FROM finora.transactions WHERE id = $1", [purchase.id])).rows[0].id as string;

      // A raw void: post the reversal and link it, exactly as the service does.
      const rawVoid = (transactionId: string, originalEntry: string) =>
        asOwner(app, voidOwner, async () => {
          const { rows } = await app.query(
            `INSERT INTO finora.journal_entries (owner_id, entry_date, description, reverses_entry_id)
             VALUES ($1, $2, 'raw void', $3) RETURNING id::text`,
            [voidOwner, today, originalEntry],
          );
          await app.query(
            `INSERT INTO finora.journal_lines (owner_id, entry_id, line_no, account_id, currency_code, side, amount_minor)
             SELECT $1, $2, l.line_no, l.account_id, l.currency_code,
                    CASE l.side WHEN 'debit' THEN 'credit'::finora.journal_line_side ELSE 'debit'::finora.journal_line_side END,
                    l.amount_minor
               FROM finora.journal_lines l WHERE l.entry_id = $3`,
            [voidOwner, rows[0].id, originalEntry],
          );
          await app.query("UPDATE finora.journal_entries SET status = 'posted' WHERE id = $1", [rows[0].id]);
          return app.query("UPDATE finora.transactions SET reversal_entry_id = $1 WHERE id = $2", [rows[0].id, transactionId]);
        });

      await expect(rawVoid(purchase.id, purchase.journalEntryId)).rejects.toThrow(REFUNDS_FIRST);
      expect((await finance.getTransaction(owner, purchase.id)).voidedAt).toBeNull();
      // Once the refund is voided, the purchase can be voided too.
      await finance.voidTransaction(owner, back.id, { date: today, idempotencyKey: randomUUID() });
      await finance.voidTransaction(owner, purchase.id, { date: today, idempotencyKey: randomUUID() });
      expect((await finance.getTransaction(owner, purchase.id)).voidedAt).not.toBeNull();
    });

    it("keeps a posted refund's link immutable, and the runtime role cannot update it at all", async () => {
      const id = (await db.query("SELECT id::text AS id FROM finora.transactions WHERE refunds_transaction_id = $1 LIMIT 1", [purchaseId])).rows[0].id as string;
      // No UPDATE grant on the column: refused before any trigger runs.
      await expect(
        asTheOwner(() => app.query("UPDATE finora.transactions SET refunds_transaction_id = NULL WHERE id = $1", [id])),
      ).rejects.toThrow(/permission denied/);
      await expect(
        asTheOwner(() => app.query("UPDATE finora.transactions SET refunds_transaction_id = $1 WHERE id = $2", [otherCardPurchaseId, id])),
      ).rejects.toThrow(/permission denied/);
      // Even a privileged connection meets the immutability guard.
      await expect(db.query("UPDATE finora.transactions SET refunds_transaction_id = NULL WHERE id = $1", [id])).rejects.toThrow(
        /a transaction's accounting fields are immutable/,
      );
      // Nothing changed.
      expect((await db.query("SELECT refunds_transaction_id::text AS r FROM finora.transactions WHERE id = $1", [id])).rows[0].r).toBe(purchaseId);
    });

    it("still refuses income into a card and transfers involving one, so only the new kind credits a card", async () => {
      for (const row of [
        { kind: "income", destination: cardId, category: shoppingId, debit: cardLedger, credit: shoppingLedger },
        { kind: "transfer", source: bankId, destination: cardId, debit: cardLedger, credit: bankLedger },
        { kind: "transfer", source: cardId, destination: bankId, debit: bankLedger, credit: cardLedger },
      ] as const) {
        const { debit, credit, ...rest } = row;
        await expect(asTheOwner(async () => insert({ ...rest, amount: 400, entry: await postedEntry(debit, credit, 400) }))).rejects.toThrow(
          /a credit card can only pay an expense, be paid by a card payment or be credited by a card refund|the category kind does not match/,
        );
      }
    });

    it("keeps every existing card expense, repayment, transfer and opening balance valid", async () => {
      // Re-run the COMMIT-time check over every transaction in the database:
      // the new rules must not have invalidated any existing shape.
      await expect(
        db.query("SELECT finora.assert_transaction_valid(id) FROM finora.transactions"),
      ).resolves.toBeTruthy();
    });
  });

  describe("concurrency", () => {
    const PARALLEL = 6;

    it("never lets simultaneous refunds of one purchase pass the amount paid between them", async () => {
      // A separate pool, so the parallel requests really are on separate
      // connections and can race inside the database.
      const { prisma: pool, finance: concurrent } = financeOn(scratch, PARALLEL);
      const { owner, named } = await newOwner(db, concurrent, pool);
      const hdfc = (await concurrent.createAccount(owner, { name: "Race card", type: "credit_card", idempotencyKey: randomUUID() })).value;
      const purchase = (
        await concurrent.recordTransaction(owner, {
          kind: "expense",
          amount: "100",
          date: today,
          sourceAccountId: hdfc.id,
          categoryId: named("Shopping").id,
          idempotencyKey: randomUUID(),
        })
      ).value;

      // Six refunds of ₹60 each against a ₹100 purchase, all at once: at most
      // one can fit, and the rest must be refused.
      const results = await Promise.allSettled(
        Array.from({ length: PARALLEL }, () =>
          concurrent.recordTransaction(owner, {
            kind: "card_refund",
            amount: "60",
            date: today,
            destinationAccountId: hdfc.id,
            refundsTransactionId: purchase.id,
            idempotencyKey: randomUUID(),
          }),
        ),
      );
      const accepted = results.filter((r) => r.status === "fulfilled");
      expect(accepted).toHaveLength(1);
      const rejected = results.filter((r) => r.status === "rejected");
      expect(rejected).toHaveLength(PARALLEL - 1);
      // Every loser was refused for the right reason: the cumulative limit,
      // not a deadlock, a timeout or a serialisation failure. The service
      // check (which holds the purchase row) reports it as a field error; a
      // loser that got past it meets the COMMIT-time check instead.
      for (const r of rejected) {
        const message = r.status === "rejected" ? String((r.reason as Error).message) : "";
        expect(message).toMatch(/Refund at most |already been refunded in full|cannot exceed what was paid for it/);
      }

      const summary = (await concurrent.getPurchaseRefunds(owner, purchase.id))!;
      expect(summary.refunded.toDecimalString()).toBe("60.00");
      expect(summary.remaining.toDecimalString()).toBe("40.00");
      // The ledger agrees: the card owes 100 - 60.
      expect((await concurrent.getAccount(owner, hdfc.id)).balance.toDecimalString()).toBe("40.00");

      // Racing refunds that DO all fit are all accepted (the lock serialises
      // them, it does not refuse them).
      const fits = await Promise.allSettled(
        Array.from({ length: 4 }, () =>
          concurrent.recordTransaction(owner, {
            kind: "card_refund",
            amount: "10",
            date: today,
            destinationAccountId: hdfc.id,
            refundsTransactionId: purchase.id,
            idempotencyKey: randomUUID(),
          }),
        ),
      );
      expect(fits.filter((r) => r.status === "fulfilled")).toHaveLength(4);
      expect((await concurrent.getPurchaseRefunds(owner, purchase.id))!.refunded.toDecimalString()).toBe("100.00");
    }, 120_000);

    it("refuses raced raw-SQL refunds too, so the limit does not depend on the service", async () => {
      // The application's own lock is bypassed entirely here: each connection
      // writes the entry, its lines and the transaction row itself. Only the
      // database's FOR UPDATE on the purchase row stands between them.
      const { owner, named } = await fresh();
      const raceCard = await card(owner, "Raw race card");
      const purchase = (await spend(owner, raceCard.id, named("Shopping").id, "100")).value;
      const ownerId = (await db.query("SELECT owner_id::text AS id FROM finora.transactions WHERE id = $1", [purchase.id])).rows[0].id as string;
      const counter = await categoryLedger(named("Shopping").id);

      const clients = await Promise.all(Array.from({ length: PARALLEL }, () => appClientOn(scratch)));
      const rawRefundOn = (client: pg.Client, amount: number) =>
        asOwner(client, ownerId, async () => {
          const { rows } = await client.query(
            "INSERT INTO finora.journal_entries (owner_id, entry_date, description) VALUES ($1, $2, 'raw race') RETURNING id::text",
            [ownerId, today],
          );
          await client.query(
            `INSERT INTO finora.journal_lines (owner_id, entry_id, line_no, account_id, currency_code, side, amount_minor)
             VALUES ($1, $2, 1, $3, 'INR', 'debit', $5), ($1, $2, 2, $4, 'INR', 'credit', $5)`,
            [ownerId, rows[0].id, raceCard.ledgerAccountId, counter, amount],
          );
          await client.query("UPDATE finora.journal_entries SET status = 'posted' WHERE id = $1", [rows[0].id]);
          return client.query(
            `INSERT INTO finora.transactions (owner_id, kind, occurred_on, amount_minor, currency_code,
               destination_account_id, category_id, refunds_transaction_id, journal_entry_id)
             VALUES ($1, 'card_refund', $2, $3, 'INR', $4, $5, $6, $7)`,
            [ownerId, today, amount, raceCard.id, named("Shopping").id, purchase.id, rows[0].id],
          );
        });

      // Six refunds of ₹60 against a ₹100 purchase, all at once on separate
      // connections: one fits, the rest must be refused by the database.
      const results = await Promise.allSettled(clients.map((client) => rawRefundOn(client, 6_000)));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of results.filter((x) => x.status === "rejected")) {
        expect(String((r as PromiseRejectedResult).reason.message)).toMatch(OVER_REFUNDED);
      }
      // The total never passed what was paid, and the ledger agrees.
      expect(
        BigInt(
          (
            await db.query(
              "SELECT coalesce(sum(amount_minor), 0)::text AS t FROM finora.transactions WHERE refunds_transaction_id = $1 AND voided_at IS NULL",
              [purchase.id],
            )
          ).rows[0].t,
        ),
      ).toBe(6_000n);
      expect((await finance.getAccount(owner, raceCard.id)).balance.toDecimalString()).toBe("40.00");
      // No orphaned transaction rows: the refused ones rolled back whole.
      expect((await db.query("SELECT count(*)::int AS n FROM finora.transactions WHERE refunds_transaction_id = $1", [purchase.id])).rows[0].n).toBe(1);
    }, 120_000);
  });
});
