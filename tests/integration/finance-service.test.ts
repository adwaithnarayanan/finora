import { randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { DEFAULT_CATEGORIES, FinanceValidationError } from "@/domain/finance";
import { parseLedgerDate } from "@/domain/ledger";
import type { AuthorizedOwner } from "@/server/auth/types";
import { createPrismaClient } from "@/server/db/client";
import { FinanceConflictError, FinanceNotFoundError } from "@/server/finance/errors";
import type { FinanceStore } from "@/server/finance/store";
import { IdempotencyConflictError, LedgerIntegrityError } from "@/server/ledger/errors";

import { adminClient, appPrisma, deleteOwners, seedOwner, type SeededOwner } from "./support/db";
import { authorize, financeFor } from "./support/ledger";

/**
 * Accounts, categories and transactions end to end against real PostgreSQL,
 * as finora_app, with the production stores and owner scope.
 */

const prisma = appPrisma();
const finance = financeFor(prisma);
let admin: pg.Client;
let seededA: SeededOwner;
let seededB: SeededOwner;
let ownerA: AuthorizedOwner;
let ownerB: AuthorizedOwner;
const extraOwners: string[] = [];

const key = () => randomUUID();
const today = "2026-10-25";

async function account(owner: AuthorizedOwner, name: string, extra: Record<string, unknown> = {}) {
  const { value } = await finance.createAccount(owner, { name, type: "bank", idempotencyKey: key(), ...extra });
  return value;
}

async function balanceOf(owner: AuthorizedOwner, id: string) {
  return (await finance.getAccount(owner, id)).balance.toDecimalString();
}

async function category(owner: AuthorizedOwner, name: string, kind: "income" | "expense") {
  const all = await finance.listCategories(owner);
  return all.find((c) => c.name === name && c.kind === kind) ?? finance.createCategory(owner, { name, kind });
}

/** Journal lines of an entry as [ledger account kind, side, amount]. */
async function lines(entryId: string) {
  const { rows } = await admin.query(
    `SELECT la.kind::text AS kind, l.side::text AS side, l.amount_minor::text AS amount, la.currency_code AS currency
       FROM finora.journal_lines l JOIN finora.ledger_accounts la ON la.id = l.account_id
      WHERE l.entry_id = $1 ORDER BY l.line_no`,
    [entryId],
  );
  return rows.map((r) => [r.kind, r.side, r.amount, r.currency]);
}

async function counts(ownerId: string) {
  const { rows } = await admin.query(
    `SELECT (SELECT count(*) FROM finora.transactions WHERE owner_id = $1)::int AS transactions,
            (SELECT count(*) FROM finora.journal_entries WHERE owner_id = $1)::int AS entries,
            (SELECT count(*) FROM finora.financial_accounts WHERE owner_id = $1)::int AS accounts,
            (SELECT count(*) FROM finora.ledger_accounts WHERE owner_id = $1)::int AS ledger_accounts`,
    [ownerId],
  );
  return rows[0] as { transactions: number; entries: number; accounts: number; ledger_accounts: number };
}

beforeAll(async () => {
  admin = await adminClient();
  seededA = await seedOwner(admin);
  seededB = await seedOwner(admin);
  ownerA = await authorize(prisma, seededA.subject);
  ownerB = await authorize(prisma, seededB.subject);
  await finance.initializeDefaultCategories(ownerA);
  await finance.initializeDefaultCategories(ownerB);
});

afterAll(async () => {
  await deleteOwners(admin, [...[seededA, seededB].filter(Boolean).map((o) => o.ownerId), ...extraOwners]);
  await admin.end();
  await prisma.$disconnect();
});

describe("accounts", () => {
  it("creates an INR bank account with an opening balance posted to opening-balance equity", async () => {
    const created = await account(ownerA, "HDFC Savings", { openingBalance: { amount: "25000.50", date: "2026-10-01" } });
    expect(created).toMatchObject({ name: "HDFC Savings", type: "bank", currency: { code: "INR", exponent: 2 }, archivedAt: null });
    const detail = await finance.getAccount(ownerA, created.id);
    expect(detail.balance.toDecimalString()).toBe("25000.50");
    expect(detail.hasHistory).toBe(true);
    expect(detail.lifecycle).toEqual({ canTransact: true, canArchive: true, canRestore: false, canDelete: false });
    const opening = detail.openingBalance!;
    expect(opening).toMatchObject({ kind: "opening_balance", occurredOn: "2026-10-01", destinationAccountId: created.id });
    expect(await lines(opening.journalEntryId)).toEqual([
      ["asset", "debit", "2500050", "INR"],
      ["equity", "credit", "2500050", "INR"],
    ]);
  });

  it("creates accounts without an opening balance, in other currencies, and validates input", async () => {
    const empty = await account(ownerA, "Wallet", { type: "cash" });
    expect((await finance.getAccount(ownerA, empty.id)).balance.toDecimalString()).toBe("0.00");
    const usd = await account(ownerA, "USD account", { currency: "USD" });
    expect(usd.currency.code).toBe("USD");
    await expect(account(ownerA, "Gold", { currency: "XAU" })).rejects.toThrow(FinanceValidationError);
    await expect(account(ownerA, "  ", { type: "credit_card" })).rejects.toMatchObject({
      issues: [expect.objectContaining({ field: "name" }), expect.objectContaining({ field: "type" })],
    });
    await expect(account(ownerA, "wallet")).rejects.toThrow(FinanceConflictError); // names are case-insensitive
    await expect(
      account(ownerA, "Bad opening", { openingBalance: { amount: "10.555", date: today } }),
    ).rejects.toMatchObject({ issues: [expect.objectContaining({ field: "openingAmount" })] });
    expect((await finance.listAccounts(ownerA)).some((a) => a.account.name === "Bad opening")).toBe(false);
  });

  it("is idempotent: a retry returns the same account, a changed retry is refused", async () => {
    const k = key();
    const input = { name: "Retry bank", type: "bank", openingBalance: { amount: "100", date: today }, idempotencyKey: k };
    const before = await counts(seededA.ownerId);
    const first = await finance.createAccount(ownerA, input);
    const second = await finance.createAccount(ownerA, input);
    expect(second).toEqual({ value: first.value, replayed: true });
    const after = await counts(seededA.ownerId);
    expect(after.accounts - before.accounts).toBe(1);
    expect(after.entries - before.entries).toBe(1);
    await expect(finance.createAccount(ownerA, { ...input, name: "Other name" })).rejects.toThrow(IdempotencyConflictError);
  });

  it("edits name and type only, archives, restores, and never changes the currency or ledger link", async () => {
    const created = await account(ownerA, "Editable");
    await finance.updateAccount(ownerA, created.id, { name: "Edited", type: "cash" });
    const edited = (await finance.getAccount(ownerA, created.id)).account;
    expect(edited).toMatchObject({ name: "Edited", type: "cash", currency: created.currency, ledgerAccountId: created.ledgerAccountId });
    await finance.archiveAccount(ownerA, created.id);
    expect((await finance.getAccount(ownerA, created.id)).lifecycle.canTransact).toBe(false);
    await finance.restoreAccount(ownerA, created.id);
    expect((await finance.getAccount(ownerA, created.id)).account.archivedAt).toBeNull();
  });

  it("deletes only accounts without history, removing the unused ledger account too", async () => {
    const before = await counts(seededA.ownerId);
    const unused = await account(ownerA, "Mistake");
    await finance.deleteAccount(ownerA, unused.id);
    expect(await counts(seededA.ownerId)).toEqual(before);
    await expect(finance.getAccount(ownerA, unused.id)).rejects.toThrow(FinanceNotFoundError);

    const used = await account(ownerA, "Used", { openingBalance: { amount: "1", date: today } });
    await expect(finance.deleteAccount(ownerA, used.id)).rejects.toMatchObject({ reason: "account-has-history" });
    expect((await finance.getAccount(ownerA, used.id)).balance.toDecimalString()).toBe("1.00");
  });
});

describe("transactions", () => {
  let bank: Awaited<ReturnType<typeof account>>;
  let cash: Awaited<ReturnType<typeof account>>;

  beforeAll(async () => {
    bank = await account(ownerA, "Primary bank", { openingBalance: { amount: "10000", date: "2026-10-01" } });
    cash = await account(ownerA, "Pocket cash", { type: "cash" });
  });

  it("income: Dr asset, Cr income category; balance increases", async () => {
    const salary = await category(ownerA, "Salary", "income");
    const { value, replayed } = await finance.recordTransaction(ownerA, {
      kind: "income",
      amount: "50000",
      date: today,
      destinationAccountId: bank.id,
      categoryId: salary.id,
      payee: "Acme Ltd",
      note: "October salary",
      idempotencyKey: key(),
    });
    expect(replayed).toBe(false);
    expect(value).toMatchObject({ kind: "income", payee: "Acme Ltd", note: "October salary", categoryId: salary.id });
    expect(value.amount.toDecimalString()).toBe("50000.00");
    expect(await lines(value.journalEntryId)).toEqual([
      ["asset", "debit", "5000000", "INR"],
      ["income", "credit", "5000000", "INR"],
    ]);
    expect(await balanceOf(ownerA, bank.id)).toBe("60000.00");
  });

  it("expense: Dr expense category, Cr asset; balance decreases", async () => {
    const groceries = await category(ownerA, "Groceries", "expense");
    const { value } = await finance.recordTransaction(ownerA, {
      kind: "expense",
      amount: "1234.56",
      date: today,
      sourceAccountId: bank.id,
      categoryId: groceries.id,
      payee: "",
      idempotencyKey: key(),
    });
    expect(value.payee).toBeNull();
    expect(await lines(value.journalEntryId)).toEqual([
      ["expense", "debit", "123456", "INR"],
      ["asset", "credit", "123456", "INR"],
    ]);
    expect(await balanceOf(ownerA, bank.id)).toBe("58765.44");
  });

  it("transfer: Dr destination asset, Cr source asset; no category, total unchanged", async () => {
    const { value } = await finance.recordTransaction(ownerA, {
      kind: "transfer",
      amount: "765.44",
      date: today,
      sourceAccountId: bank.id,
      destinationAccountId: cash.id,
      idempotencyKey: key(),
    });
    expect(value.categoryId).toBeNull();
    expect(await lines(value.journalEntryId)).toEqual([
      ["asset", "debit", "76544", "INR"],
      ["asset", "credit", "76544", "INR"],
    ]);
    expect(await balanceOf(ownerA, bank.id)).toBe("58000.00");
    expect(await balanceOf(ownerA, cash.id)).toBe("765.44");
  });

  it("rejects invalid intents before anything is written", async () => {
    const salary = await category(ownerA, "Salary", "income");
    const groceries = await category(ownerA, "Groceries", "expense");
    const usd = await account(ownerA, "USD wallet", { currency: "USD", type: "cash" });
    const before = await counts(seededA.ownerId);
    const attempts: [string, Record<string, unknown>, string][] = [
      ["zero amount", { kind: "income", amount: "0", destinationAccountId: bank.id, categoryId: salary.id }, "amount"],
      ["float syntax", { kind: "income", amount: "1e3", destinationAccountId: bank.id, categoryId: salary.id }, "amount"],
      ["too precise", { kind: "income", amount: "1.001", destinationAccountId: bank.id, categoryId: salary.id }, "amount"],
      ["wrong category kind", { kind: "income", amount: "1", destinationAccountId: bank.id, categoryId: groceries.id }, "categoryId"],
      ["unknown account", { kind: "expense", amount: "1", sourceAccountId: randomUUID(), categoryId: groceries.id }, "sourceAccountId"],
      ["same-account transfer", { kind: "transfer", amount: "1", sourceAccountId: bank.id, destinationAccountId: bank.id }, "destinationAccountId"],
      ["currency mismatch", { kind: "transfer", amount: "1", sourceAccountId: bank.id, destinationAccountId: usd.id }, "destinationAccountId"],
      ["unknown kind", { kind: "refund", amount: "1" }, "kind"],
    ];
    for (const [label, input, field] of attempts) {
      await expect(
        finance.recordTransaction(ownerA, { date: today, idempotencyKey: key(), ...input }),
        label,
      ).rejects.toMatchObject({ issues: expect.arrayContaining([expect.objectContaining({ field })]) });
    }
    const after = await counts(seededA.ownerId);
    expect(after.transactions).toBe(before.transactions);
    expect(after.entries).toBe(before.entries);
  });

  it("refuses new transactions on archived accounts and categories", async () => {
    const archived = await account(ownerA, "Old bank");
    await finance.archiveAccount(ownerA, archived.id);
    const salary = await category(ownerA, "Salary", "income");
    await expect(
      finance.recordTransaction(ownerA, {
        kind: "income",
        amount: "1",
        date: today,
        destinationAccountId: archived.id,
        categoryId: salary.id,
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({ issues: [expect.objectContaining({ field: "destinationAccountId" })] });
    await expect(
      finance.setOpeningBalance(ownerA, archived.id, { amount: "5", date: today, idempotencyKey: key() }),
    ).rejects.toThrow(FinanceValidationError);

    const temp = await finance.createCategory(ownerA, { name: `Temp ${randomUUID().slice(0, 6)}`, kind: "income" });
    await finance.setCategoryArchived(ownerA, temp.id, true);
    await expect(
      finance.recordTransaction(ownerA, {
        kind: "income",
        amount: "1",
        date: today,
        destinationAccountId: bank.id,
        categoryId: temp.id,
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({ issues: [expect.objectContaining({ field: "categoryId" })] });
  });

  it("is idempotent: a retried request records nothing new; a changed retry is refused", async () => {
    const salary = await category(ownerA, "Salary", "income");
    const k = key();
    const input = { kind: "income", amount: "10", date: today, destinationAccountId: cash.id, categoryId: salary.id, note: "tip", idempotencyKey: k };
    const before = await balanceOf(ownerA, cash.id);
    const first = await finance.recordTransaction(ownerA, input);
    const second = await finance.recordTransaction(ownerA, input);
    expect(second).toEqual({ value: first.value, replayed: true });
    expect(Number(await balanceOf(ownerA, cash.id)) - Number(before)).toBe(10);
    await expect(finance.recordTransaction(ownerA, { ...input, note: "different" })).rejects.toThrow(IdempotencyConflictError);
  });

  it("voids through a ledger reversal, once, keeping the original in history", async () => {
    const groceries = await category(ownerA, "Groceries", "expense");
    const before = await balanceOf(ownerA, bank.id);
    const { value: spent } = await finance.recordTransaction(ownerA, {
      kind: "expense",
      amount: "500",
      date: today,
      sourceAccountId: bank.id,
      categoryId: groceries.id,
      idempotencyKey: key(),
    });
    const k = key();
    const { value: voided } = await finance.voidTransaction(ownerA, spent.id, { date: today, idempotencyKey: k });
    expect(voided.voidedAt).toBeInstanceOf(Date);
    expect(voided.reversalEntryId).not.toBeNull();
    expect(await balanceOf(ownerA, bank.id)).toBe(before);
    expect(await lines(voided.reversalEntryId!)).toEqual([
      ["expense", "credit", "50000", "INR"],
      ["asset", "debit", "50000", "INR"],
    ]);
    expect(await finance.voidTransaction(ownerA, spent.id, { date: today, idempotencyKey: k })).toMatchObject({ replayed: true });
    await expect(finance.voidTransaction(ownerA, spent.id, { date: today, idempotencyKey: key() })).rejects.toMatchObject({
      reason: "already-voided",
    });
    const history = await finance.listTransactions(ownerA, { accountId: bank.id });
    expect(history.find((t) => t.id === spent.id)?.voidedAt).toBeInstanceOf(Date);
    expect(await finance.listTransactions(ownerA, { accountId: bank.id, includeVoided: false })).not.toContainEqual(
      expect.objectContaining({ id: spent.id }),
    );
  });

  it("edits payee and note only, without touching the accounting effect", async () => {
    const salary = await category(ownerA, "Salary", "income");
    const { value } = await finance.recordTransaction(ownerA, {
      kind: "income",
      amount: "42",
      date: today,
      destinationAccountId: cash.id,
      categoryId: salary.id,
      payee: "Old payee",
      idempotencyKey: key(),
    });
    const entryLines = await lines(value.journalEntryId);
    await finance.updateTransactionDetails(ownerA, value.id, { payee: "New payee", note: "Fixed typo" });
    const updated = await finance.getTransaction(ownerA, value.id);
    expect(updated).toMatchObject({ payee: "New payee", note: "Fixed typo", journalEntryId: value.journalEntryId });
    expect(updated.amount.equals(value.amount)).toBe(true);
    expect(await lines(value.journalEntryId)).toEqual(entryLines);
  });

  it("filters history by date, type, account, category and text", async () => {
    const all = await finance.listTransactions(ownerA);
    expect(all.length).toBeGreaterThan(3);
    expect((await finance.listTransactions(ownerA, { kind: "transfer" })).every((t) => t.kind === "transfer")).toBe(true);
    expect((await finance.listTransactions(ownerA, { accountId: cash.id })).every((t) => t.sourceAccountId === cash.id || t.destinationAccountId === cash.id)).toBe(true);
    expect((await finance.listTransactions(ownerA, { search: "acme" })).map((t) => t.payee)).toContain("Acme Ltd");
    expect(await finance.listTransactions(ownerA, { from: parseLedgerDate("2030-01-01") })).toEqual([]);
    expect((await finance.listTransactions(ownerA, { to: parseLedgerDate("2026-10-01") })).every((t) => t.occurredOn <= "2026-10-01")).toBe(true);
  });
});

describe("opening balances", () => {
  it("cannot be set twice or overwritten; corrections reverse and replace it", async () => {
    const created = await account(ownerA, "Opening test");
    const k = key();
    const { value: first } = await finance.setOpeningBalance(ownerA, created.id, { amount: "1000", date: "2026-09-30", idempotencyKey: k });
    expect(await finance.setOpeningBalance(ownerA, created.id, { amount: "1000", date: "2026-09-30", idempotencyKey: k })).toMatchObject({
      replayed: true,
    });
    await expect(
      finance.setOpeningBalance(ownerA, created.id, { amount: "2000", date: "2026-09-30", idempotencyKey: key() }),
    ).rejects.toMatchObject({ reason: "opening-balance-exists" });

    const ck = key();
    const { value: corrected } = await finance.correctOpeningBalance(ownerA, created.id, {
      amount: "1500",
      date: "2026-09-30",
      idempotencyKey: ck,
    });
    expect(corrected).toMatchObject({ kind: "opening_balance", replacesTransactionId: first.id });
    expect(await balanceOf(ownerA, created.id)).toBe("1500.00");
    const original = await finance.getTransaction(ownerA, first.id);
    expect(original.voidedAt).toBeInstanceOf(Date);
    expect(original.replacedByTransactionId).toBe(corrected.id);
    expect(await finance.correctOpeningBalance(ownerA, created.id, { amount: "1500", date: "2026-09-30", idempotencyKey: ck })).toMatchObject({
      replayed: true,
      value: { id: corrected.id },
    });
    // The original journal entry is unchanged, offset by a linked reversal.
    expect(await lines(first.journalEntryId)).toEqual([
      ["asset", "debit", "100000", "INR"],
      ["equity", "credit", "100000", "INR"],
    ]);
  });

  it("refuses to correct a missing opening balance", async () => {
    const created = await account(ownerA, "No opening");
    await expect(
      finance.correctOpeningBalance(ownerA, created.id, { amount: "1", date: today, idempotencyKey: key() }),
    ).rejects.toMatchObject({ reason: "no-opening-balance" });
  });
});

describe("atomicity", () => {
  it("rolls back the journal entry when recording the transaction fails", async () => {
    const created = await account(ownerA, "Atomic bank");
    const salary = await category(ownerA, "Salary", "income");
    const failing = financeFor(prisma, (stores) => ({
      ledger: stores.ledger,
      finance: new Proxy(stores.finance, {
        get(target, prop, receiver) {
          if (prop === "insertTransaction") return async () => { throw new Error("simulated crash after posting"); };
          const value = Reflect.get(target, prop, receiver) as unknown;
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      }) as FinanceStore,
    }));
    const before = await counts(seededA.ownerId);
    await expect(
      failing.recordTransaction(ownerA, {
        kind: "income",
        amount: "5",
        date: today,
        destinationAccountId: created.id,
        categoryId: salary.id,
        idempotencyKey: key(),
      }),
    ).rejects.toThrow("simulated crash");
    expect(await counts(seededA.ownerId)).toEqual(before);
  });

  it("rolls back the account and its ledger account when the opening balance fails", async () => {
    const before = await counts(seededA.ownerId);
    const failing = financeFor(prisma, (stores) => ({
      ledger: new Proxy(stores.ledger, {
        get(target, prop, receiver) {
          if (prop === "markPosted") return async () => { throw new Error("simulated ledger failure"); };
          const value = Reflect.get(target, prop, receiver) as unknown;
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      }),
      finance: stores.finance,
    }));
    await expect(
      failing.createAccount(ownerA, { name: "Never", type: "bank", openingBalance: { amount: "1", date: today }, idempotencyKey: key() }),
    ).rejects.toThrow("simulated ledger failure");
    expect(await counts(seededA.ownerId)).toEqual(before);
  });

  it("lets the database veto a transaction whose entry does not match it", async () => {
    // A buggy store records the transaction with a different amount than posted.
    const created = await account(ownerA, "Veto bank");
    const salary = await category(ownerA, "Salary", "income");
    const buggy = financeFor(prisma, (stores) => ({
      ledger: stores.ledger,
      finance: new Proxy(stores.finance, {
        get(target, prop, receiver) {
          if (prop === "insertTransaction") {
            return (row: Parameters<FinanceStore["insertTransaction"]>[0]) =>
              target.insertTransaction({ ...row, amount: row.amount.add(row.amount) });
          }
          const value = Reflect.get(target, prop, receiver) as unknown;
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      }) as FinanceStore,
    }));
    const before = await counts(seededA.ownerId);
    await expect(
      buggy.recordTransaction(ownerA, {
        kind: "income",
        amount: "5",
        date: today,
        destinationAccountId: created.id,
        categoryId: salary.id,
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({ reason: "the journal entry does not match the transaction" });
    expect(await counts(seededA.ownerId)).toEqual(before);
    await expect(Promise.reject(new LedgerIntegrityError("x"))).rejects.toBeInstanceOf(LedgerIntegrityError);
  });
});

describe("concurrency", () => {
  const PARALLEL = 6;
  const pool = createPrismaClient(inject("local").appDatabaseUrl, PARALLEL);
  const concurrent = financeFor(pool);
  afterAll(() => pool.$disconnect());

  it("records once when the same request races itself", async () => {
    const created = await account(ownerA, "Race bank");
    const salary = await category(ownerA, "Salary", "income");
    const input = { kind: "income", amount: "7", date: today, destinationAccountId: created.id, categoryId: salary.id, idempotencyKey: key() };
    const results = await Promise.allSettled(Array.from({ length: PARALLEL }, () => concurrent.recordTransaction(ownerA, input)));
    const values = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    expect(values).toHaveLength(PARALLEL);
    expect(new Set(values.map((v) => v.value.id)).size).toBe(1);
    expect(values.filter((v) => !v.replayed)).toHaveLength(1);
    expect(await balanceOf(ownerA, created.id)).toBe("7.00");
  });

  it("creates one account when account creation races itself", async () => {
    const input = { name: `Race ${randomUUID().slice(0, 6)}`, type: "bank", openingBalance: { amount: "3", date: today }, idempotencyKey: key() };
    const results = await Promise.allSettled(Array.from({ length: PARALLEL }, () => concurrent.createAccount(ownerA, input)));
    const values = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    expect(values).toHaveLength(PARALLEL);
    expect(new Set(values.map((v) => v.value.id)).size).toBe(1);
    expect(await balanceOf(ownerA, values[0]!.value.id)).toBe("3.00");
  });

  it("allows only one opening balance when two different requests race", async () => {
    const created = await account(ownerA, `Opening race ${randomUUID().slice(0, 6)}`);
    const results = await Promise.allSettled(
      Array.from({ length: PARALLEL }, (_, i) =>
        concurrent.setOpeningBalance(ownerA, created.id, { amount: String(i + 1), date: today, idempotencyKey: key() }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM finora.transactions WHERE destination_account_id = $1 AND voided_at IS NULL",
      [created.id],
    );
    expect(rows[0].n).toBe(1);
  });

  it("does not let an archive race past a transaction (or vice versa)", async () => {
    const created = await account(ownerA, `Archive race ${randomUUID().slice(0, 6)}`);
    const salary = await category(ownerA, "Salary", "income");
    const results = await Promise.allSettled([
      concurrent.recordTransaction(ownerA, { kind: "income", amount: "1", date: today, destinationAccountId: created.id, categoryId: salary.id, idempotencyKey: key() }),
      concurrent.archiveAccount(ownerA, created.id),
    ]);
    expect(results[1].status).toBe("fulfilled");
    const { rows } = await admin.query(
      `SELECT t.created_at, fa.archived_at FROM finora.transactions t JOIN finora.financial_accounts fa ON fa.id = t.destination_account_id
        WHERE fa.id = $1`,
      [created.id],
    );
    // Either the income committed before the archive, or it was refused.
    for (const row of rows) expect(row.created_at.getTime()).toBeLessThanOrEqual(row.archived_at.getTime());
  });
});

describe("owner isolation", () => {
  it("never lets owner B see or use owner A's accounts, categories or transactions", async () => {
    const aAccount = await account(ownerA, "A private", { openingBalance: { amount: "99", date: today } });
    const aCategory = await category(ownerA, "Salary", "income");
    const bAccount = await account(ownerB, "B bank");
    const aTransactions = await finance.listTransactions(ownerA, { accountId: aAccount.id });

    expect((await finance.listAccounts(ownerB)).map((a) => a.account.id)).not.toContain(aAccount.id);
    await expect(finance.getAccount(ownerB, aAccount.id)).rejects.toThrow(FinanceNotFoundError);
    await expect(finance.updateAccount(ownerB, aAccount.id, { name: "Hijack", type: "bank" })).rejects.toThrow(FinanceNotFoundError);
    await expect(finance.archiveAccount(ownerB, aAccount.id)).rejects.toThrow(FinanceNotFoundError);
    await expect(finance.deleteAccount(ownerB, aAccount.id)).rejects.toThrow(FinanceNotFoundError);
    await expect(finance.getTransaction(ownerB, aTransactions[0]!.id)).rejects.toThrow(FinanceNotFoundError);
    await expect(finance.voidTransaction(ownerB, aTransactions[0]!.id, { date: today, idempotencyKey: key() })).rejects.toThrow(
      FinanceNotFoundError,
    );
    await expect(
      finance.setOpeningBalance(ownerB, aAccount.id, { amount: "1", date: today, idempotencyKey: key() }),
    ).rejects.toThrow(FinanceNotFoundError);
    // Referencing A's account or category from B's own transaction:
    await expect(
      finance.recordTransaction(ownerB, { kind: "transfer", amount: "1", date: today, sourceAccountId: bAccount.id, destinationAccountId: aAccount.id, idempotencyKey: key() }),
    ).rejects.toMatchObject({ issues: [expect.objectContaining({ field: "destinationAccountId", message: "That account does not exist" })] });
    await expect(
      finance.recordTransaction(ownerB, { kind: "income", amount: "1", date: today, destinationAccountId: bAccount.id, categoryId: aCategory.id, idempotencyKey: key() }),
    ).rejects.toMatchObject({ issues: [expect.objectContaining({ field: "categoryId" })] });
    expect(await balanceOf(ownerA, aAccount.id)).toBe("99.00");
  });
});

describe("default categories (explicit setup only)", () => {
  async function freshOwner() {
    const seeded = await seedOwner(admin);
    extraOwners.push(seeded.ownerId);
    return { seeded, owner: await authorize(prisma, seeded.subject) };
  }
  const categoryCount = async (ownerId: string) =>
    (await admin.query("SELECT count(*)::int AS n FROM finora.categories WHERE owner_id = $1", [ownerId])).rows[0].n as number;

  it("is never triggered by reads", async () => {
    const { seeded, owner } = await freshOwner();
    expect(await finance.listCategories(owner)).toEqual([]);
    await finance.listAccounts(owner);
    await finance.listTransactions(owner);
    expect(await categoryCount(seeded.ownerId)).toBe(0);
  });

  it("creates the defaults once and is idempotent", async () => {
    const { seeded, owner } = await freshOwner();
    expect(await finance.initializeDefaultCategories(owner)).toEqual({ created: DEFAULT_CATEGORIES.length });
    expect(await finance.initializeDefaultCategories(owner)).toEqual({ created: 0 });
    expect(await categoryCount(seeded.ownerId)).toBe(DEFAULT_CATEGORIES.length);
  });

  it("never touches an owner who already has categories (custom ones are preserved)", async () => {
    const { seeded, owner } = await freshOwner();
    await finance.createCategory(owner, { name: "Freelance", kind: "income" });
    expect(await finance.initializeDefaultCategories(owner)).toEqual({ created: 0 });
    expect((await finance.listCategories(owner)).map((c) => c.name)).toEqual(["Freelance"]);
    expect(await categoryCount(seeded.ownerId)).toBe(1);
  });

  it("creates exactly one set under concurrent requests, for that owner only", async () => {
    const { seeded, owner } = await freshOwner();
    const pool = createPrismaClient(inject("local").appDatabaseUrl, 6);
    try {
      const results = await Promise.all(Array.from({ length: 6 }, () => financeFor(pool).initializeDefaultCategories(owner)));
      expect(results.reduce((sum, r) => sum + r.created, 0)).toBe(DEFAULT_CATEGORIES.length);
    } finally {
      await pool.$disconnect();
    }
    expect(await categoryCount(seeded.ownerId)).toBe(DEFAULT_CATEGORIES.length);
    expect(await categoryCount(seededB.ownerId)).toBe((await finance.listCategories(ownerB)).length);
  });
});

describe("account names are unique per owner regardless of letter case", () => {
  it("refuses a name that differs only by case, on create and rename", async () => {
    await account(ownerA, "Joint Savings");
    await expect(account(ownerA, "JOINT savings")).rejects.toMatchObject({ reason: "account-name-taken" });
    const other = await account(ownerA, "Other Savings");
    await expect(finance.updateAccount(ownerA, other.id, { name: "joint SAVINGS", type: "bank" })).rejects.toMatchObject({
      reason: "account-name-taken",
    });
    // Renaming an account to a new case of its own name is fine.
    await finance.updateAccount(ownerA, other.id, { name: "OTHER savings", type: "bank" });
  });

  it("lets different owners use the same name", async () => {
    await account(ownerA, "Shared Name");
    await expect(account(ownerB, "shared NAME")).resolves.toMatchObject({ name: "shared NAME" });
  });

  it("compares names exactly, not as patterns", async () => {
    await account(ownerA, "A_c");
    await expect(account(ownerA, "Abc")).resolves.toMatchObject({ name: "Abc" });
    await account(ownerA, "100%");
    await expect(account(ownerA, "100x")).resolves.toMatchObject({ name: "100x" });
  });

  it("creates exactly one account when case variants race", async () => {
    const pool = createPrismaClient(inject("local").appDatabaseUrl, 6);
    try {
      const names = ["Race Name", "RACE NAME", "race name", "Race name", "rACE nAME", "RaCe NaMe"];
      const results = await Promise.allSettled(
        names.map((name) => financeFor(pool).createAccount(ownerA, { name, type: "bank", idempotencyKey: key() })),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of results) {
        if (r.status === "rejected") expect(r.reason).toMatchObject({ reason: "account-name-taken" });
      }
    } finally {
      await pool.$disconnect();
    }
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM finora.financial_accounts WHERE owner_id = $1 AND lower(name) = 'race name'",
      [seededA.ownerId],
    );
    expect(rows[0].n).toBe(1);
  });

  it("reports the database's case-insensitive index as a friendly conflict when the app check is skipped", async () => {
    await account(ownerA, "Backstop");
    const skipping = financeFor(prisma, (stores) => ({
      ledger: stores.ledger,
      finance: new Proxy(stores.finance, {
        get(target, prop, receiver) {
          if (prop === "accountNameTaken") return async () => false;
          const value = Reflect.get(target, prop, receiver) as unknown;
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      }) as FinanceStore,
    }));
    const before = await counts(seededA.ownerId);
    const error = await skipping
      .createAccount(ownerA, { name: "BACKSTOP", type: "bank", idempotencyKey: key() })
      .then(() => null, (e: unknown) => e as Error);
    expect(error).toBeInstanceOf(FinanceConflictError);
    expect(error?.message).toBe("You already have an account with that name");
    expect(error?.message).not.toMatch(/financial_accounts|unique|constraint|SQL/i);
    expect(await counts(seededA.ownerId)).toEqual(before); // the ledger account was rolled back too
  });
});
