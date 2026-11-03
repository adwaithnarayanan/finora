import { randomUUID } from "node:crypto";

import pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import type { AuthorizedOwner } from "@/server/auth/types";
import { IdempotencyConflictError } from "@/server/ledger/errors";

import {
  lines,
  counts,
  dataSnapshot,
  functionCatalog,
  triggerCatalog,
  migrationRows,
} from "./support/catalog";
import { asOwner, authorize, financeFor, ledgerFor } from "./support/ledger";
import { historyOn } from "./support/pre-migration";
import { type ScratchDatabase, deployMigrations } from "./support/scratch-db";
import { newOwner, scratchHarness } from "./support/scratch-harness";

const CARD_EXPENSES = "20261025000800_card_expenses";
const BEFORE = "20261025000700_account_ledger_class";
const today = "2026-10-25";
const UNSUPPORTED =
  /a credit card can only pay an expense, be paid by a card payment or be credited by a card refund; income and transfers use bank and cash accounts only/;

const { scratchDatabase, financeOn, appClientOn, deployThrough } =
  scratchHarness();

describe("migration 20261025000800_card_expenses", () => {
  it("applies to existing data without changing a row or any other rule, and then accepts card expenses", async () => {
    const scratch = await scratchDatabase("cardexp_migrate", BEFORE);
    const db = scratch.client;
    const app = await appClientOn(scratch);
    const { prisma, finance } = financeOn(scratch);
    const { seeded, owner, named } = await newOwner(db, finance, prisma);

    const bank = (
      await finance.createAccount(owner, {
        name: "Axis",
        type: "bank",
        idempotencyKey: randomUUID(),
      })
    ).value;
    const card = (
      await finance.createAccount(owner, {
        name: "HDFC Card",
        type: "credit_card",
        idempotencyKey: randomUUID(),
      })
    ).value;
    const history = historyOn({
      db,
      ledger: ledgerFor(prisma),
      owner,
      ownerId: seeded.ownerId,
      date: today,
    });
    const equity = await history.openingEquity();
    const salaryLedger = await history.mapCategory(
      named("Salary").id,
      "income",
    );
    const expenseLedger = await history.mapCategory(
      named("Groceries").id,
      "expense",
    );
    await history.record({
      kind: "opening_balance",
      amount: "50000",
      debit: bank.ledgerAccountId,
      credit: equity,
      destination: bank.id,
    });
    await history.record({
      kind: "opening_balance",
      amount: "12000",
      debit: equity,
      credit: card.ledgerAccountId,
      destination: card.id,
    });
    await history.record({
      kind: "income",
      amount: "1000",
      debit: bank.ledgerAccountId,
      credit: salaryLedger,
      destination: bank.id,
      category: named("Salary").id,
    });
    const spent = await history.record({
      kind: "expense",
      amount: "250",
      debit: expenseLedger,
      credit: bank.ledgerAccountId,
      source: bank.id,
      category: named("Groceries").id,
    });
    await history.void(spent);

    const rawCardExpense = () =>
      asOwner(app, seeded.ownerId, async () => {
        const { rows } = await app.query(
          "INSERT INTO finora.journal_entries (owner_id, entry_date, description) VALUES ($1, $2, 'raw') RETURNING id::text",
          [seeded.ownerId, today],
        );
        await app.query(
          `INSERT INTO finora.journal_lines (owner_id, entry_id, line_no, account_id, currency_code, side, amount_minor)
           VALUES ($1, $2, 1, $3, 'INR', 'debit', 125000), ($1, $2, 2, $4, 'INR', 'credit', 125000)`,
          [seeded.ownerId, rows[0].id, expenseLedger, card.ledgerAccountId],
        );
        await app.query(
          "UPDATE finora.journal_entries SET status = 'posted' WHERE id = $1",
          [rows[0].id],
        );
        await app.query(
          `INSERT INTO finora.transactions (owner_id, kind, occurred_on, amount_minor, currency_code, source_account_id, category_id, journal_entry_id)
           VALUES ($1, 'expense', $2, 125000, 'INR', $3, $4, $5)`,
          [seeded.ownerId, today, card.id, named("Groceries").id, rows[0].id],
        );
      });
    await expect(rawCardExpense()).rejects.toThrow(
      /income, expenses and transfers use bank and cash accounts only/,
    );

    const before = await dataSnapshot(db);
    const functionsBefore = await functionCatalog(db);
    const triggersBefore = await triggerCatalog(db);

    deployThrough(scratch, CARD_EXPENSES);

    expect(await migrationRows(db, CARD_EXPENSES)).toEqual([
      { finished: true, rolled_back: false },
    ]);
    expect(await dataSnapshot(db)).toEqual(before);
    expect(await triggerCatalog(db)).toEqual(triggersBefore);
    const functionsAfter = await functionCatalog(db);
    const withoutBody = (rows: { proname: string; body: string }[]) =>
      rows.map((row) => ({ ...row, body: undefined }));
    expect(withoutBody(functionsAfter)).toEqual(withoutBody(functionsBefore));
    expect(
      functionsAfter
        .filter((f, i) => f.body !== functionsBefore[i]!.body)
        .map((f) => f.proname),
    ).toEqual(["assert_transaction_valid"]);

    await rawCardExpense();

    deployMigrations(scratch.url);
    const purchase = await finance.recordTransaction(owner, {
      kind: "expense",
      amount: "1250",
      date: today,
      sourceAccountId: card.id,
      categoryId: named("Shopping").id,
      idempotencyKey: randomUUID(),
    });
    expect(await lines(db, purchase.value.journalEntryId)).toEqual([
      ["expense", "debit", "125000", "INR"],
      ["liability", "credit", "125000", "INR"],
    ]);
    expect(
      (await finance.getAccount(owner, card.id)).balance.toDecimalString(),
    ).toBe("14500.00");
    expect(
      (await finance.getAccount(owner, bank.id)).balance.toDecimalString(),
    ).toBe("51000.00");
  }, 180_000);
});

describe("expenses paid by credit card (migrated scratch database)", () => {
  let scratch: ScratchDatabase;
  let db: pg.Client;
  let app: pg.Client;
  let finance: ReturnType<typeof financeFor>;
  let prisma: Parameters<typeof authorize>[0];

  beforeAll(async () => {
    scratch = await scratchDatabase("cardexp");
    db = scratch.client;
    app = await appClientOn(scratch);
    ({ prisma, finance } = financeOn(scratch));
  }, 120_000);

  const fresh = () => newOwner(db, finance, prisma);
  const balanceOf = async (owner: AuthorizedOwner, id: string) =>
    (await finance.getAccount(owner, id)).balance.toDecimalString();
  const card = async (
    owner: AuthorizedOwner,
    name: string,
    extra: Record<string, unknown> = {},
  ) =>
    (
      await finance.createAccount(owner, {
        name,
        type: "credit_card",
        idempotencyKey: randomUUID(),
        ...extra,
      })
    ).value;
  const bank = async (
    owner: AuthorizedOwner,
    name: string,
    extra: Record<string, unknown> = {},
  ) =>
    (
      await finance.createAccount(owner, {
        name,
        type: "bank",
        idempotencyKey: randomUUID(),
        ...extra,
      })
    ).value;

  describe("service", () => {
    it("posts Dr expense category / Cr card liability, so the amount owed grows, and lists it in the card's history", async () => {
      const { seeded, owner, named } = await fresh();
      const hdfc = await card(owner, "HDFC Card", {
        openingBalance: { amount: "12000", date: "2026-10-01" },
      });
      const axis = await bank(owner, "Axis", {
        openingBalance: { amount: "50000", date: "2026-10-01" },
      });
      const before = await counts(db, seeded.ownerId);

      const { value: purchase, replayed } = await finance.recordTransaction(
        owner,
        {
          kind: "expense",
          amount: "1250.00",
          date: "2026-10-24",
          sourceAccountId: hdfc.id,
          categoryId: named("Shopping").id,
          payee: "Bata",
          note: "Shoes",
          idempotencyKey: randomUUID(),
        },
      );
      expect(replayed).toBe(false);
      expect(purchase).toMatchObject({
        kind: "expense",
        occurredOn: "2026-10-24",
        sourceAccountId: hdfc.id,
        destinationAccountId: null,
        categoryId: named("Shopping").id,
        payee: "Bata",
        note: "Shoes",
      });
      expect(purchase.amount.toDecimalString()).toBe("1250.00");
      expect(await lines(db, purchase.journalEntryId)).toEqual([
        ["expense", "debit", "125000", "INR"],
        ["liability", "credit", "125000", "INR"],
      ]);
      expect(await counts(db, seeded.ownerId)).toEqual({
        transactions: before.transactions + 1,
        entries: before.entries + 1,
        lines: before.lines + 2,
      });
      expect(await balanceOf(owner, hdfc.id)).toBe("13250.00");
      expect(await balanceOf(owner, axis.id)).toBe("50000.00");

      const history = await finance.listTransactions(owner, {
        accountId: hdfc.id,
      });
      expect(
        history.map((t) => [
          t.kind,
          t.occurredOn,
          t.amount.toDecimalString(),
          t.payee,
        ]),
      ).toEqual([
        ["expense", "2026-10-24", "1250.00", "Bata"],
        ["opening_balance", "2026-10-01", "12000.00", null],
      ]);

      const fromBank = await finance.recordTransaction(owner, {
        kind: "expense",
        amount: "40",
        date: today,
        sourceAccountId: axis.id,
        categoryId: named("Groceries").id,
        idempotencyKey: randomUUID(),
      });
      expect(await lines(db, fromBank.value.journalEntryId)).toEqual([
        ["expense", "debit", "4000", "INR"],
        ["asset", "credit", "4000", "INR"],
      ]);
      expect(await balanceOf(owner, axis.id)).toBe("49960.00");
      expect(await balanceOf(owner, hdfc.id)).toBe("13250.00");
    });

    it("voids a card expense with its exact mirror, reducing the amount owed again", async () => {
      const { owner, named } = await fresh();
      const hdfc = await card(owner, "Void card", {
        openingBalance: { amount: "1000", date: today },
      });
      const { value } = await finance.recordTransaction(owner, {
        kind: "expense",
        amount: "300",
        date: today,
        sourceAccountId: hdfc.id,
        categoryId: named("Dining out").id,
        idempotencyKey: randomUUID(),
      });
      expect(await balanceOf(owner, hdfc.id)).toBe("1300.00");
      const voided = await finance.voidTransaction(owner, value.id, {
        date: today,
        idempotencyKey: randomUUID(),
      });
      expect(await lines(db, voided.value.reversalEntryId!)).toEqual([
        ["expense", "credit", "30000", "INR"],
        ["liability", "debit", "30000", "INR"],
      ]);
      expect(await balanceOf(owner, hdfc.id)).toBe("1000.00");
      await finance.updateTransactionDetails(owner, value.id, {
        payee: "Cafe",
        note: "edited after void",
      });
    });

    it("posts in the card's own currency and precision, with the category's ledger account in that currency", async () => {
      const { owner, named } = await fresh();
      const usd = await card(owner, "USD card", { currency: "USD" });
      await expect(
        finance.recordTransaction(owner, {
          kind: "expense",
          amount: "12.345",
          date: today,
          sourceAccountId: usd.id,
          categoryId: named("Shopping").id,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({
        issues: [
          expect.objectContaining({
            field: "amount",
            message: expect.stringMatching(/USD/),
          }),
        ],
      });
      const { value } = await finance.recordTransaction(owner, {
        kind: "expense",
        amount: "12.34",
        date: today,
        sourceAccountId: usd.id,
        categoryId: named("Shopping").id,
        idempotencyKey: randomUUID(),
      });
      expect(value.amount.currency.code).toBe("USD");
      expect(await lines(db, value.journalEntryId)).toEqual([
        ["expense", "debit", "1234", "USD"],
        ["liability", "credit", "1234", "USD"],
      ]);
      expect(await balanceOf(owner, usd.id)).toBe("12.34");
    });

    it("replays a retried card expense once, and refuses the same key for any other business field, writing nothing", async () => {
      const { seeded, owner, named } = await fresh();
      const hdfc = await card(owner, "Retry card");
      const other = await card(owner, "Other card");
      const axis = await bank(owner, "Retry bank", {
        openingBalance: { amount: "5000", date: today },
      });
      const input = {
        kind: "expense",
        amount: "1250",
        date: today,
        sourceAccountId: hdfc.id,
        categoryId: named("Shopping").id,
        payee: "Bata",
        note: "Shoes",
        idempotencyKey: randomUUID(),
      };
      const first = await finance.recordTransaction(owner, input);
      const after = await counts(db, seeded.ownerId);
      expect(await finance.recordTransaction(owner, input)).toEqual({
        value: first.value,
        replayed: true,
      });

      for (const change of [
        { sourceAccountId: other.id },
        { sourceAccountId: axis.id },
        { categoryId: named("Groceries").id },
        { amount: "1250.01" },
        { date: "2026-10-24" },
        { payee: "Other shop" },
        { note: "Not shoes" },
      ]) {
        await expect(
          finance.recordTransaction(owner, { ...input, ...change }),
          JSON.stringify(change),
        ).rejects.toThrow(IdempotencyConflictError);
      }
      expect(await counts(db, seeded.ownerId)).toEqual(after);
      expect(await balanceOf(owner, hdfc.id)).toBe("1250.00");
      expect(await balanceOf(owner, other.id)).toBe("0.00");
      expect(await balanceOf(owner, axis.id)).toBe("5000.00");
    });

    it("refuses an archived card or category, and another owner's card, writing nothing", async () => {
      const { seeded, owner, named } = await fresh();
      const other = await fresh();
      const hdfc = await card(owner, "Archived card");
      const theirs = await card(other.owner, "Their card");
      const before = await counts(db, seeded.ownerId);
      const expense = (extra: Record<string, unknown>) =>
        finance.recordTransaction(owner, {
          kind: "expense",
          amount: "10",
          date: today,
          sourceAccountId: hdfc.id,
          categoryId: named("Health").id,
          idempotencyKey: randomUUID(),
          ...extra,
        });

      await finance.archiveAccount(owner, hdfc.id);
      await expect(expense({})).rejects.toMatchObject({
        issues: [
          {
            field: "sourceAccountId",
            message: expect.stringMatching(/is archived/),
          },
        ],
      });
      await finance.restoreAccount(owner, hdfc.id);

      await finance.setCategoryArchived(owner, named("Health").id, true);
      await expect(expense({})).rejects.toMatchObject({
        issues: [expect.objectContaining({ field: "categoryId" })],
      });
      await finance.setCategoryArchived(owner, named("Health").id, false);

      await expect(
        expense({ sourceAccountId: theirs.id }),
      ).rejects.toMatchObject({
        issues: [
          { field: "sourceAccountId", message: "That account does not exist" },
        ],
      });
      expect(await counts(db, seeded.ownerId)).toEqual(before);
      expect(await balanceOf(other.owner, theirs.id)).toBe("0.00");
      await expect(expense({})).resolves.toMatchObject({ replayed: false });
    });

    it("still refuses income into a card and transfers from, to or between cards, writing nothing", async () => {
      const { seeded, owner, named } = await fresh();
      const hdfc = await card(owner, "Card A");
      const icici = await card(owner, "Card B");
      const axis = await bank(owner, "Bank", {
        openingBalance: { amount: "100", date: today },
      });
      const before = await counts(db, seeded.ownerId);
      const attempts: [Record<string, unknown>, string][] = [
        [
          {
            kind: "income",
            destinationAccountId: hdfc.id,
            categoryId: named("Salary").id,
          },
          "destinationAccountId",
        ],
        [
          {
            kind: "transfer",
            sourceAccountId: hdfc.id,
            destinationAccountId: axis.id,
          },
          "sourceAccountId",
        ],
        [
          {
            kind: "transfer",
            sourceAccountId: axis.id,
            destinationAccountId: hdfc.id,
          },
          "destinationAccountId",
        ],
        [
          {
            kind: "transfer",
            sourceAccountId: hdfc.id,
            destinationAccountId: icici.id,
          },
          "destinationAccountId",
        ],
      ];
      for (const [intent, field] of attempts) {
        await expect(
          finance.recordTransaction(owner, {
            amount: "10",
            date: today,
            idempotencyKey: randomUUID(),
            ...intent,
          }),
        ).rejects.toMatchObject({
          issues: [
            {
              field,
              message: expect.stringMatching(
                /is a credit card; a card can only pay for an expense/,
              ),
            },
          ],
        });
      }
      expect(await counts(db, seeded.ownerId)).toEqual(before);
      expect(await balanceOf(owner, axis.id)).toBe("100.00");
    });
  });

  describe("database rules at COMMIT (raw SQL as finora_app, bypassing the application)", () => {
    let ownerId: string;
    let otherOwnerId: string;
    let cardId: string;
    let cardLedger: string;
    let card2Id: string;
    let card2Ledger: string;
    let usdCardId: string;
    let bankId: string;
    let bankLedger: string;
    let otherCardId: string;
    let groceriesId: string;
    let groceriesLedger: string;
    let salaryId: string;
    let salaryLedger: string;

    async function postedEntry(
      debit: string,
      credit: string,
      amount: number,
      currency = "INR",
    ): Promise<string> {
      const { rows } = await app.query(
        "INSERT INTO finora.journal_entries (owner_id, entry_date, description) VALUES ($1, $2, 'raw') RETURNING id::text",
        [ownerId, today],
      );
      await app.query(
        `INSERT INTO finora.journal_lines (owner_id, entry_id, line_no, account_id, currency_code, side, amount_minor)
         VALUES ($1, $2, 1, $3, $6, 'debit', $5), ($1, $2, 2, $4, $6, 'credit', $5)`,
        [ownerId, rows[0].id, debit, credit, amount, currency],
      );
      await app.query(
        "UPDATE finora.journal_entries SET status = 'posted' WHERE id = $1",
        [rows[0].id],
      );
      return rows[0].id as string;
    }

    const insert = (row: {
      kind: string;
      amount: number;
      source?: string;
      destination?: string;
      category?: string;
      entry: string;
      currency?: string;
    }) =>
      app.query(
        `INSERT INTO finora.transactions (owner_id, kind, occurred_on, amount_minor, currency_code,
           source_account_id, destination_account_id, category_id, journal_entry_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          ownerId,
          row.kind,
          today,
          row.amount,
          row.currency ?? "INR",
          row.source ?? null,
          row.destination ?? null,
          row.category ?? null,
          row.entry,
        ],
      );
    const asTheOwner = <T>(work: () => Promise<T>) =>
      asOwner(app, ownerId, work);
    const cardTransactions = async (id: string) =>
      (
        await db.query(
          "SELECT count(*)::int AS n FROM finora.transactions WHERE source_account_id = $1 OR destination_account_id = $1",
          [id],
        )
      ).rows[0].n as number;

    beforeAll(async () => {
      const { seeded, owner, named } = await fresh();
      const other = await fresh();
      ownerId = seeded.ownerId;
      otherOwnerId = other.seeded.ownerId;
      const hdfc = await card(owner, "Raw card");
      const icici = await card(owner, "Raw card 2");
      const axis = await bank(owner, "Raw bank", {
        openingBalance: { amount: "100", date: today },
      });
      [cardId, cardLedger, card2Id, card2Ledger, bankId, bankLedger] = [
        hdfc.id,
        hdfc.ledgerAccountId,
        icici.id,
        icici.ledgerAccountId,
        axis.id,
        axis.ledgerAccountId,
      ];
      usdCardId = (await card(owner, "Raw USD card", { currency: "USD" })).id;
      otherCardId = (await card(other.owner, "Other owner's card")).id;
      groceriesId = named("Groceries").id;
      salaryId = named("Salary").id;
      await finance.recordTransaction(owner, {
        kind: "expense",
        amount: "1",
        date: today,
        sourceAccountId: bankId,
        categoryId: groceriesId,
        idempotencyKey: randomUUID(),
      });
      await finance.recordTransaction(owner, {
        kind: "income",
        amount: "1",
        date: today,
        destinationAccountId: bankId,
        categoryId: salaryId,
        idempotencyKey: randomUUID(),
      });
      const mapped = async (categoryId: string) =>
        (
          await db.query(
            "SELECT ledger_account_id::text AS id FROM finora.category_ledger_accounts WHERE category_id = $1 AND currency_code = 'INR'",
            [categoryId],
          )
        ).rows[0].id as string;
      groceriesLedger = await mapped(groceriesId);
      salaryLedger = await mapped(salaryId);
    }, 60_000);

    it("accepts a card expense whose entry is exactly Dr expense / Cr card", async () => {
      await asTheOwner(async () =>
        insert({
          kind: "expense",
          amount: 125000,
          source: cardId,
          category: groceriesId,
          entry: await postedEntry(groceriesLedger, cardLedger, 125000),
        }),
      );
      expect(await cardTransactions(cardId)).toBe(1);
    });

    it.each([
      [
        "the wrong direction (Dr card / Cr expense)",
        () => ({
          debit: cardLedger,
          credit: groceriesLedger,
          entryAmount: 500,
          amount: 500,
        }),
      ],
      [
        "another card's liability account",
        () => ({
          debit: groceriesLedger,
          credit: card2Ledger,
          entryAmount: 500,
          amount: 500,
        }),
      ],
      [
        "a different amount",
        () => ({
          debit: groceriesLedger,
          credit: cardLedger,
          entryAmount: 500,
          amount: 501,
        }),
      ],
    ])("refuses a card expense whose entry has %s", async (_label, parts) => {
      const { debit, credit, entryAmount, amount } = parts();
      await expect(
        asTheOwner(async () =>
          insert({
            kind: "expense",
            amount,
            source: cardId,
            category: groceriesId,
            entry: await postedEntry(debit, credit, entryAmount),
          }),
        ),
      ).rejects.toThrow(/the journal entry does not match the transaction/);
    });

    it.each([
      [
        "income into a card",
        () => ({
          kind: "income",
          destination: cardId,
          category: salaryId,
          debit: cardLedger,
          credit: salaryLedger,
        }),
      ],
      [
        "a transfer from a card to a bank account",
        () => ({
          kind: "transfer",
          source: cardId,
          destination: bankId,
          debit: bankLedger,
          credit: cardLedger,
        }),
      ],
      [
        "a transfer from a bank account to a card",
        () => ({
          kind: "transfer",
          source: bankId,
          destination: cardId,
          debit: cardLedger,
          credit: bankLedger,
        }),
      ],
      [
        "a transfer between two cards",
        () => ({
          kind: "transfer",
          source: cardId,
          destination: card2Id,
          debit: card2Ledger,
          credit: cardLedger,
        }),
      ],
    ])(
      "refuses %s at COMMIT, even with an entry matching the template",
      async (_label, make) => {
        const { debit, credit, ...row } = make();
        const before = await cardTransactions(card2Id);
        await expect(
          asTheOwner(async () =>
            insert({
              ...row,
              amount: 700,
              entry: await postedEntry(debit, credit, 700),
            }),
          ),
        ).rejects.toThrow(UNSUPPORTED);
        expect(await cardTransactions(card2Id)).toBe(before);
      },
    );

    it("refuses a card expense on an archived card or category", async () => {
      await asTheOwner(() =>
        app.query(
          "UPDATE finora.financial_accounts SET archived_at = now() WHERE id = $1",
          [card2Id],
        ),
      );
      try {
        await expect(
          asTheOwner(async () =>
            insert({
              kind: "expense",
              amount: 900,
              source: card2Id,
              category: groceriesId,
              entry: await postedEntry(groceriesLedger, card2Ledger, 900),
            }),
          ),
        ).rejects.toThrow(/archived accounts cannot take new transactions/);
      } finally {
        await asTheOwner(() =>
          app.query(
            "UPDATE finora.financial_accounts SET archived_at = NULL WHERE id = $1",
            [card2Id],
          ),
        );
      }
      await asTheOwner(() =>
        app.query(
          "UPDATE finora.categories SET archived_at = now() WHERE id = $1",
          [groceriesId],
        ),
      );
      try {
        await expect(
          asTheOwner(async () =>
            insert({
              kind: "expense",
              amount: 900,
              source: card2Id,
              category: groceriesId,
              entry: await postedEntry(groceriesLedger, card2Ledger, 900),
            }),
          ),
        ).rejects.toThrow(/archived categories cannot take new transactions/);
      } finally {
        await asTheOwner(() =>
          app.query(
            "UPDATE finora.categories SET archived_at = NULL WHERE id = $1",
            [groceriesId],
          ),
        );
      }
    });

    it("refuses another owner's card and a currency other than the card's", async () => {
      await expect(
        asTheOwner(async () =>
          insert({
            kind: "expense",
            amount: 900,
            source: otherCardId,
            category: groceriesId,
            entry: await postedEntry(groceriesLedger, cardLedger, 900),
          }),
        ),
      ).rejects.toThrow(/transactions_source_account_fkey/);
      await expect(
        asTheOwner(async () =>
          insert({
            kind: "expense",
            amount: 900,
            source: usdCardId,
            category: groceriesId,
            entry: await postedEntry(groceriesLedger, cardLedger, 900),
          }),
        ),
      ).rejects.toThrow(/transactions_source_account_fkey/);
      expect(await cardTransactions(otherCardId)).toBe(0);
      expect(await cardTransactions(usdCardId)).toBe(0);
      expect(otherOwnerId).not.toBe(ownerId);
    });

    it("keeps the function private and invoker-rights, its trigger deferred and enabled, and pins the transaction kinds", async () => {
      const { rows } = await db.query(
        `SELECT p.prosecdef, array_to_string(p.proconfig, ',') AS config, pg_get_userbyid(p.proowner) AS owner,
                has_function_privilege('finora_app', p.oid, 'EXECUTE') AS app_can_execute,
                has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute
           FROM pg_proc p WHERE p.oid = 'finora.assert_transaction_valid(uuid)'::regprocedure`,
      );
      expect(rows).toEqual([
        {
          prosecdef: false,
          config: 'search_path=""',
          owner: expect.any(String),
          app_can_execute: false,
          anon_can_execute: false,
        },
      ]);
      await expect(
        app.query("SELECT finora.assert_transaction_valid(gen_random_uuid())"),
      ).rejects.toThrow(/permission denied/);
      const trigger = await db.query(
        `SELECT t.tgfoid::regproc::text AS fn, t.tgenabled, t.tgdeferrable, t.tginitdeferred, p.prosecdef
           FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
          WHERE t.tgrelid = 'finora.transactions'::regclass AND t.tgname = 'transactions_validate'`,
      );
      expect(trigger.rows).toEqual([
        {
          fn: "finora.transactions_validate",
          tgenabled: "O",
          tgdeferrable: true,
          tginitdeferred: true,
          prosecdef: true,
        },
      ]);
      const kinds = await db.query(
        "SELECT unnest(enum_range(NULL::finora.transaction_kind))::text AS kind",
      );
      expect(kinds.rows.map((r) => r.kind)).toEqual([
        "opening_balance",
        "income",
        "expense",
        "transfer",
        "card_payment",
        "card_refund",
      ]);
    });
  });
});
