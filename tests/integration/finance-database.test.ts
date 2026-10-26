import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ACCOUNT_LEDGER_KIND, FINANCIAL_ACCOUNT_TYPES } from "@/domain/finance";
import type { AuthorizedOwner } from "@/server/auth/types";
import type { TransactionRecord } from "@/server/finance/store";

import { adminClient, appClient, appPrisma, deleteOwners, seedOwner, type SeededOwner } from "./support/db";
import { asOwner, authorize, financeFor } from "./support/ledger";

/**
 * Database-level protections of the finance tables, exercised with raw SQL
 * that bypasses the application: as the runtime role (RLS and grants apply)
 * and, where noted, as the migration role (triggers still apply).
 */

const prisma = appPrisma();
const finance = financeFor(prisma);
let admin: pg.Client;
let app: pg.Client;
let a: SeededOwner;
let b: SeededOwner;
let ownerA: AuthorizedOwner;
let ownerB: AuthorizedOwner;
let bankId: string;
let bankLedgerId: string;
let otherBankId: string;
let bAccountId: string;
let income: TransactionRecord;
const today = "2026-10-25";

/** Posts a balanced two-line entry for owner A as finora_app, returning its id. */
async function postedEntry(debit: string, credit: string, amount: number): Promise<string> {
  const { rows } = await app.query(
    "INSERT INTO finora.journal_entries (owner_id, entry_date, description) VALUES ($1, $2, 'raw') RETURNING id::text",
    [a.ownerId, today],
  );
  const entry = rows[0].id as string;
  await app.query(
    `INSERT INTO finora.journal_lines (owner_id, entry_id, line_no, account_id, currency_code, side, amount_minor)
     VALUES ($1, $2, 1, $3, 'INR', 'debit', $5), ($1, $2, 2, $4, 'INR', 'credit', $5)`,
    [a.ownerId, entry, debit, credit, amount],
  );
  await app.query("UPDATE finora.journal_entries SET status = 'posted' WHERE id = $1", [entry]);
  return entry;
}

const insertTransfer = (entry: string, amount: number, source = otherBankId, destination = bankId) =>
  app.query(
    `INSERT INTO finora.transactions (owner_id, kind, occurred_on, amount_minor, currency_code,
       source_account_id, destination_account_id, journal_entry_id)
     VALUES ($1, 'transfer', $2, $3, 'INR', $4, $5, $6)`,
    [a.ownerId, today, amount, source, destination, entry],
  );

async function ledgerIdOf(accountId: string) {
  const { rows } = await admin.query("SELECT ledger_account_id::text AS id FROM finora.financial_accounts WHERE id = $1", [accountId]);
  return rows[0].id as string;
}

beforeAll(async () => {
  admin = await adminClient();
  app = await appClient();
  a = await seedOwner(admin);
  b = await seedOwner(admin);
  ownerA = await authorize(prisma, a.subject);
  ownerB = await authorize(prisma, b.subject);
  await finance.initializeDefaultCategories(ownerA);
  const bank = await finance.createAccount(ownerA, {
    name: "Raw bank",
    type: "bank",
    openingBalance: { amount: "100", date: today },
    idempotencyKey: randomUUID(),
  });
  bankId = bank.value.id;
  bankLedgerId = bank.value.ledgerAccountId;
  otherBankId = (await finance.createAccount(ownerA, { name: "Raw other", type: "bank", idempotencyKey: randomUUID() })).value.id;
  bAccountId = (await finance.createAccount(ownerB, { name: "B raw", type: "bank", idempotencyKey: randomUUID() })).value.id;
  const salary = (await finance.listCategories(ownerA)).find((c) => c.name === "Salary")!;
  income = (
    await finance.recordTransaction(ownerA, {
      kind: "income",
      amount: "10",
      date: today,
      destinationAccountId: bankId,
      categoryId: salary.id,
      idempotencyKey: randomUUID(),
    })
  ).value;
});

afterAll(async () => {
  await app?.end();
  await deleteOwners(admin, [a, b].filter(Boolean).map((o) => o.ownerId));
  await admin?.end();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await app.query("ROLLBACK").catch(() => undefined);
});

describe("transactions must agree with the ledger (checked at COMMIT)", () => {
  it("accepts a transfer whose entry is exactly its template", async () => {
    await expect(
      asOwner(app, a.ownerId, async () => {
        const entry = await postedEntry(bankLedgerId, await ledgerIdOf(otherBankId), 500);
        await insertTransfer(entry, 500);
      }),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["a different amount", (entry: string) => insertTransfer(entry, 499)],
    ["swapped accounts", (entry: string) => insertTransfer(entry, 500, bankId, otherBankId)],
  ])("rejects %s and leaves nothing behind", async (_label, insert) => {
    const before = await admin.query("SELECT count(*)::int AS n FROM finora.journal_entries WHERE owner_id = $1", [a.ownerId]);
    await expect(
      asOwner(app, a.ownerId, async () => {
        const entry = await postedEntry(bankLedgerId, await ledgerIdOf(otherBankId), 500);
        await insert(entry);
      }),
    ).rejects.toThrow(/finora\.finance: the journal entry does not match the transaction/);
    const after = await admin.query("SELECT count(*)::int AS n FROM finora.journal_entries WHERE owner_id = $1", [a.ownerId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("rejects a transaction for an unposted entry", async () => {
    await expect(
      asOwner(app, a.ownerId, async () => {
        const { rows } = await app.query(
          "INSERT INTO finora.journal_entries (owner_id, entry_date, description) VALUES ($1, $2, 'draft') RETURNING id::text",
          [a.ownerId, today],
        );
        await insertTransfer(rows[0].id, 500);
      }),
    ).rejects.toThrow(/posted, non-reversal journal entry/);
  });

  it("rejects a void that does not link the reversal of the transaction's entry", async () => {
    const unrelated = await asOwner(app, a.ownerId, () => postedEntry(bankLedgerId, bankLedgerId, 1));
    await expect(
      asOwner(app, a.ownerId, () =>
        app.query("UPDATE finora.transactions SET reversal_entry_id = $1 WHERE id = $2", [unrelated, income.id]),
      ),
    ).rejects.toThrow(/a void must link the posted reversal/);
  });

  it("rejects a second active opening balance even through raw SQL", async () => {
    await expect(
      asOwner(app, a.ownerId, () =>
        app.query(
          `INSERT INTO finora.transactions (owner_id, kind, occurred_on, amount_minor, currency_code, destination_account_id, journal_entry_id)
           SELECT owner_id, 'opening_balance', occurred_on, amount_minor, currency_code, destination_account_id, journal_entry_id
             FROM finora.transactions WHERE destination_account_id = $1 AND kind = 'opening_balance'`,
          [bankId],
        ),
      ),
    ).rejects.toThrow(/already has an opening balance/);
  });
});

describe("posted accounting effects are immutable", () => {
  const attempts: [string, string][] = [
    ["change the amount", "UPDATE finora.transactions SET amount_minor = 1 WHERE id = $1"],
    ["change the date", "UPDATE finora.transactions SET occurred_on = '2020-01-01' WHERE id = $1"],
    ["change the account", "UPDATE finora.transactions SET destination_account_id = NULL WHERE id = $1"],
    ["delete the transaction", "DELETE FROM finora.transactions WHERE id = $1"],
  ];

  it.each(attempts)("the runtime role cannot %s", async (_label, sql) => {
    await expect(asOwner(app, a.ownerId, () => app.query(sql, [income.id]))).rejects.toThrow(/permission denied/);
  });

  it.each(attempts)("the migration role cannot %s", async (_label, sql) => {
    await expect(admin.query(sql, [income.id])).rejects.toThrow(/finora\.finance: /);
  });

  it("allows only payee and note to change", async () => {
    await asOwner(app, a.ownerId, () =>
      app.query("UPDATE finora.transactions SET payee = 'Edited', note = 'Edited note' WHERE id = $1", [income.id]),
    );
    const { rows } = await admin.query("SELECT payee, note, amount_minor::text FROM finora.transactions WHERE id = $1", [income.id]);
    expect(rows[0]).toEqual({ payee: "Edited", note: "Edited note", amount_minor: "1000" });
  });

  it("keeps an account's currency and ledger link fixed, and its history undeletable", async () => {
    await expect(
      asOwner(app, a.ownerId, () => app.query("UPDATE finora.financial_accounts SET currency_code = 'USD' WHERE id = $1", [bankId])),
    ).rejects.toThrow(/permission denied/);
    await expect(admin.query("UPDATE finora.financial_accounts SET currency_code = 'USD' WHERE id = $1", [bankId])).rejects.toThrow(
      /immutable|financial_accounts_ledger_account_fkey/,
    );
    await expect(admin.query("DELETE FROM finora.financial_accounts WHERE id = $1", [bankId])).rejects.toThrow(
      /cannot be deleted; archive it instead/,
    );
    await expect(
      asOwner(app, a.ownerId, () => app.query("DELETE FROM finora.ledger_accounts WHERE id = $1", [bankLedgerId])),
    ).rejects.toThrow(/foreign key/);
  });

  it("refuses new transactions on an archived account at the database level", async () => {
    await admin.query("UPDATE finora.financial_accounts SET archived_at = now() WHERE id = $1", [otherBankId]);
    try {
      await expect(
        asOwner(app, a.ownerId, async () => {
          const entry = await postedEntry(bankLedgerId, await ledgerIdOf(otherBankId), 5);
          await insertTransfer(entry, 5);
        }),
      ).rejects.toThrow(/archived accounts cannot take new transactions/);
    } finally {
      await admin.query("UPDATE finora.financial_accounts SET archived_at = NULL WHERE id = $1", [otherBankId]);
    }
  });

  it("refuses a category ledger mapping to a ledger account of the wrong kind", async () => {
    const category = (await finance.listCategories(ownerA)).find((c) => c.name === "Rent")!;
    await expect(
      asOwner(app, a.ownerId, () =>
        app.query(
          "INSERT INTO finora.category_ledger_accounts (owner_id, category_id, currency_code, ledger_account_id) VALUES ($1, $2, 'INR', $3)",
          [a.ownerId, category.id, bankLedgerId],
        ),
      ),
    ).rejects.toThrow(/wrong kind|category_ledger_accounts_ledger_account_key/);
  });
});

describe("owner isolation (RLS and composite keys)", () => {
  const tables = ["financial_accounts", "categories", "category_ledger_accounts", "system_ledger_accounts", "transactions"];

  it("shows owner B none of owner A's rows, and shows nothing without context", async () => {
    for (const table of tables) {
      const asB = await asOwner(app, b.ownerId, () => app.query(`SELECT 1 FROM finora.${table} WHERE owner_id = $1`, [a.ownerId]));
      expect(asB.rowCount, table).toBe(0);
      const none = await asOwner(app, null, () => app.query(`SELECT 1 FROM finora.${table}`));
      expect(none.rowCount, table).toBe(0);
    }
  });

  it("cannot reference another owner's account from its own transaction", async () => {
    await expect(
      asOwner(app, a.ownerId, async () => {
        const entry = await postedEntry(bankLedgerId, await ledgerIdOf(otherBankId), 5);
        await insertTransfer(entry, 5, bAccountId, bankId);
      }),
    ).rejects.toThrow(/transactions_source_account_fkey/);
  });

  it("cannot write rows for another owner", async () => {
    await expect(
      asOwner(app, a.ownerId, () =>
        app.query("INSERT INTO finora.categories (owner_id, name, kind) VALUES ($1, 'Forged', 'income')", [b.ownerId]),
      ),
    ).rejects.toThrow(/row-level security/);
    const updated = await asOwner(app, a.ownerId, () =>
      app.query("UPDATE finora.financial_accounts SET name = 'Hijacked' WHERE id = $1", [bAccountId]),
    );
    expect(updated.rowCount).toBe(0);
  });
});

describe("account classes (ADR 0008): type and ledger kind agree", () => {
  let cardId: string;
  let cardLedgerId: string;
  let bCardLedgerId: string;
  let equityId: string;
  let ledgerSeq = 0;

  /** A new ledger account of `kind` for owner A, inserted as finora_app. */
  const newLedger = (kind: string, ownerId = a.ownerId) =>
    app
      .query("INSERT INTO finora.ledger_accounts (owner_id, name, kind, currency_code) VALUES ($1, $2, $3, 'INR') RETURNING id::text", [
        ownerId,
        `itest:class:${randomUUID()}:${ledgerSeq++}`,
        kind,
      ])
      .then(({ rows }) => rows[0].id as string);

  const insertAccount = (type: string, ledgerId: string, ownerId = a.ownerId) =>
    app.query(
      `INSERT INTO finora.financial_accounts (owner_id, name, name_key, type, currency_code, ledger_account_id, creation_key, creation_fingerprint)
       VALUES ($1, $2, $2, $3, 'INR', $4, $5, repeat('0', 64))`,
      [ownerId, `class ${randomUUID()}`, type, ledgerId, `itest-${randomUUID()}`],
    );

  const insertOpening = (entry: string, accountId: string, amount: number) =>
    app.query(
      `INSERT INTO finora.transactions (owner_id, kind, occurred_on, amount_minor, currency_code, destination_account_id, journal_entry_id)
       VALUES ($1, 'opening_balance', $2, $3, 'INR', $4, $5)`,
      [a.ownerId, today, amount, accountId, entry],
    );

  beforeAll(async () => {
    const card = await finance.createAccount(ownerA, { name: "Raw card", type: "credit_card", idempotencyKey: randomUUID() });
    cardId = card.value.id;
    cardLedgerId = card.value.ledgerAccountId;
    bCardLedgerId = (await finance.createAccount(ownerB, { name: "B raw card", type: "credit_card", idempotencyKey: randomUUID() })).value
      .ledgerAccountId;
    const { rows } = await admin.query(
      "SELECT ledger_account_id::text AS id FROM finora.system_ledger_accounts WHERE owner_id = $1 AND purpose = 'opening_balance_equity' AND currency_code = 'INR'",
      [a.ownerId],
    );
    equityId = rows[0].id;
  });

  it("maps every account type exactly as the application does", async () => {
    const { rows } = await admin.query(
      `SELECT t::text AS type, finora.financial_account_ledger_kind(t)::text AS kind
         FROM unnest(enum_range(NULL::finora.financial_account_type)) AS t ORDER BY 1`,
    );
    expect([...FINANCIAL_ACCOUNT_TYPES].sort()).toEqual(rows.map((r) => r.type));
    expect(Object.fromEntries(rows.map((r) => [r.type, r.kind]))).toEqual(ACCOUNT_LEDGER_KIND);
  });

  it.each([
    ["a credit card backed by an asset ledger account", "credit_card", "asset"],
    ["a bank account backed by a liability ledger account", "bank", "liability"],
    ["a cash account backed by a liability ledger account", "cash", "liability"],
    ["a credit card backed by an equity ledger account", "credit_card", "equity"],
    ["a bank account backed by an expense ledger account", "bank", "expense"],
  ])("refuses %s, even as raw SQL by the runtime role", async (_label, type, kind) => {
    await expect(
      asOwner(app, a.ownerId, async () => insertAccount(type, await newLedger(kind))),
    ).rejects.toThrow(/must be backed by a ledger account of its type's class/);
  });

  it.each([
    ["credit_card", "liability"],
    ["bank", "asset"],
    ["cash", "asset"],
  ])("accepts a %s backed by a(n) %s ledger account", async (type, kind) => {
    await expect(asOwner(app, a.ownerId, async () => insertAccount(type, await newLedger(kind)))).resolves.toBeDefined();
  });

  it("refuses a card backed by another owner's liability ledger account", async () => {
    await expect(asOwner(app, a.ownerId, () => insertAccount("credit_card", bCardLedgerId))).rejects.toThrow(
      /must be backed by a ledger account of its type's class|financial_accounts_ledger_account_fkey/,
    );
  });

  it.each([
    ["a card to a bank account", () => cardId, "bank"],
    ["a card to cash", () => cardId, "cash"],
    ["a bank account to a card", () => otherBankId, "credit_card"],
  ])("refuses changing %s, by the runtime role and by the migration role", async (_label, id, type) => {
    await expect(
      asOwner(app, a.ownerId, () => app.query("UPDATE finora.financial_accounts SET type = $1 WHERE id = $2", [type, id()])),
    ).rejects.toThrow(/an account's type cannot change its class/);
    await expect(admin.query("UPDATE finora.financial_accounts SET type = $1 WHERE id = $2", [type, id()])).rejects.toThrow(
      /an account's type cannot change its class/,
    );
  });

  it("still allows bank <-> cash, and changes within a card's own type", async () => {
    await asOwner(app, a.ownerId, () => app.query("UPDATE finora.financial_accounts SET type = 'cash' WHERE id = $1", [otherBankId]));
    await asOwner(app, a.ownerId, () => app.query("UPDATE finora.financial_accounts SET type = 'bank' WHERE id = $1", [otherBankId]));
    await asOwner(app, a.ownerId, () =>
      app.query("UPDATE finora.financial_accounts SET type = 'credit_card', archived_at = now() WHERE id = $1", [cardId]),
    );
    await asOwner(app, a.ownerId, () => app.query("UPDATE finora.financial_accounts SET archived_at = NULL WHERE id = $1", [cardId]));
    const { rows } = await admin.query("SELECT id::text, type::text FROM finora.financial_accounts WHERE id = ANY($1::uuid[]) ORDER BY type", [
      [otherBankId, cardId],
    ]);
    expect(rows.map((r) => r.type)).toEqual(["bank", "credit_card"]);
  });

  it("accepts a card's opening balance only as Dr equity / Cr card (checked at COMMIT)", async () => {
    await expect(
      asOwner(app, a.ownerId, async () => insertOpening(await postedEntry(cardLedgerId, equityId, 1200000), cardId, 1200000)),
    ).rejects.toThrow(/the journal entry does not match the transaction/);
    const counted = () => admin.query("SELECT count(*)::int AS n FROM finora.transactions WHERE destination_account_id = $1", [cardId]);
    expect((await counted()).rows[0].n).toBe(0);
    await asOwner(app, a.ownerId, async () => insertOpening(await postedEntry(equityId, cardLedgerId, 1200000), cardId, 1200000));
    expect((await counted()).rows[0].n).toBe(1);
  });

  it("still accepts an asset's opening balance only as Dr account / Cr equity", async () => {
    const otherLedgerId = await ledgerIdOf(otherBankId);
    await expect(
      asOwner(app, a.ownerId, async () => insertOpening(await postedEntry(equityId, otherLedgerId, 500), otherBankId, 500)),
    ).rejects.toThrow(/the journal entry does not match the transaction/);
  });

  it("rejects an unbalanced opening entry for a card (the ledger's own COMMIT check)", async () => {
    const fresh = (await finance.createAccount(ownerA, { name: "Raw card 2", type: "credit_card", idempotencyKey: randomUUID() })).value;
    await expect(
      asOwner(app, a.ownerId, async () => {
        const { rows } = await app.query(
          "INSERT INTO finora.journal_entries (owner_id, entry_date, description) VALUES ($1, $2, 'raw') RETURNING id::text",
          [a.ownerId, today],
        );
        await app.query(
          `INSERT INTO finora.journal_lines (owner_id, entry_id, line_no, account_id, currency_code, side, amount_minor)
           VALUES ($1, $2, 1, $3, 'INR', 'debit', 100), ($1, $2, 2, $4, 'INR', 'credit', 99)`,
          [a.ownerId, rows[0].id, equityId, fresh.ledgerAccountId],
        );
        await app.query("UPDATE finora.journal_entries SET status = 'posted' WHERE id = $1", [rows[0].id]);
        await insertOpening(rows[0].id, fresh.id, 100);
      }),
    ).rejects.toThrow(/finora\.ledger: /);
  });

  it("accepts an expense paid by card at COMMIT only as Dr expense / Cr card, and refuses card income and transfers", async () => {
    const groceries = (await finance.listCategories(ownerA)).find((c) => c.name === "Groceries")!;
    const salary = (await finance.listCategories(ownerA)).find((c) => c.name === "Salary")!;
    const mappedLedger = async (categoryId: string, kind: string) => {
      const { rows } = await admin.query(
        "SELECT ledger_account_id::text AS id FROM finora.category_ledger_accounts WHERE category_id = $1 AND currency_code = 'INR'",
        [categoryId],
      );
      return (
        rows[0]?.id ??
        (await asOwner(app, a.ownerId, async () => {
          const id = await newLedger(kind);
          await app.query("INSERT INTO finora.category_ledger_accounts (owner_id, category_id, currency_code, ledger_account_id) VALUES ($1, $2, 'INR', $3)", [
            a.ownerId,
            categoryId,
            id,
          ]);
          return id;
        }))
      );
    };
    const expenseLedger = await mappedLedger(groceries.id, "expense");
    const incomeLedger = await mappedLedger(salary.id, "income");
    const insertCardExpense = (entry: string) =>
      app.query(
        `INSERT INTO finora.transactions (owner_id, kind, occurred_on, amount_minor, currency_code, source_account_id, category_id, journal_entry_id)
         VALUES ($1, 'expense', $2, 125000, 'INR', $3, $4, $5)`,
        [a.ownerId, today, cardId, groceries.id, entry],
      );

    await expect(
      asOwner(app, a.ownerId, async () => insertCardExpense(await postedEntry(cardLedgerId, expenseLedger, 125000))),
    ).rejects.toThrow(/the journal entry does not match the transaction/);
    await asOwner(app, a.ownerId, async () => insertCardExpense(await postedEntry(expenseLedger, cardLedgerId, 125000)));

    const unsupported = /a credit card can only pay an expense; income and transfers use bank and cash accounts only/;
    await expect(
      asOwner(app, a.ownerId, async () => {
        const entry = await postedEntry(cardLedgerId, incomeLedger, 500);
        await app.query(
          `INSERT INTO finora.transactions (owner_id, kind, occurred_on, amount_minor, currency_code, destination_account_id, category_id, journal_entry_id)
           VALUES ($1, 'income', $2, 500, 'INR', $3, $4, $5)`,
          [a.ownerId, today, cardId, salary.id, entry],
        );
      }),
    ).rejects.toThrow(unsupported);
    await expect(
      asOwner(app, a.ownerId, async () => insertTransfer(await postedEntry(cardLedgerId, bankLedgerId, 500), 500, bankId, cardId)),
    ).rejects.toThrow(unsupported);
    await expect(
      asOwner(app, a.ownerId, async () => insertTransfer(await postedEntry(bankLedgerId, cardLedgerId, 500), 500, cardId, bankId)),
    ).rejects.toThrow(unsupported);
  });

  it("keeps the mapping function private: PUBLIC and the runtime role cannot call it", async () => {
    await expect(app.query("SELECT finora.financial_account_ledger_kind('bank')")).rejects.toThrow(/permission denied/);
    const { rows } = await admin.query(
      `SELECT p.prosecdef, p.provolatile, array_to_string(p.proconfig, ',') AS config
         FROM pg_proc p WHERE p.oid = 'finora.financial_account_ledger_kind(finora.financial_account_type)'::regprocedure`,
    );
    expect(rows).toEqual([{ prosecdef: false, provolatile: "i", config: "search_path=\"\"" }]);
  });
});

describe("account-name key index: catalog definition", () => {
  // The same read-only query the hosted runbook uses after a deployment.
  const VERIFY_SQL = readFileSync(path.join(process.cwd(), "scripts/db/sql/verify-account-name-key-index.sql"), "utf8");
  type Verification = {
    present: boolean;
    on_expected_table: boolean;
    is_unique: boolean;
    is_valid_and_ready: boolean;
    keys_are_owner_id_and_name_key: boolean;
    key_collation_is_c: boolean;
    key_column_is_c_and_not_null: boolean;
    no_other_name_index: boolean;
    definition_matches: boolean;
    definition: string | null;
    ok: boolean;
  };

  /** Runs the check in a transaction that is always rolled back, after `setup` (if any). */
  async function verify(setup?: string): Promise<Verification> {
    await admin.query("BEGIN");
    try {
      if (setup) await admin.query(setup);
      await admin.query("SET LOCAL search_path = pg_catalog");
      const { rows } = await admin.query<Verification>(VERIFY_SQL);
      expect(rows).toHaveLength(1);
      return rows[0]!;
    } finally {
      await admin.query("ROLLBACK");
    }
  }

  it('is unique on (owner_id, name_key COLLATE "C") of finora.financial_accounts, valid, and the only name index', async () => {
    expect(await verify()).toEqual({
      present: true,
      on_expected_table: true,
      is_unique: true,
      is_valid_and_ready: true,
      keys_are_owner_id_and_name_key: true,
      key_collation_is_c: true,
      key_column_is_c_and_not_null: true,
      no_other_name_index: true,
      definition_matches: true,
      definition: "CREATE UNIQUE INDEX financial_accounts_owner_name_key_key ON finora.financial_accounts USING btree (owner_id, name_key)",
      ok: true,
    });
  });

  const IDX = "financial_accounts_owner_name_key_key";
  const replace = (create: string) => `DROP INDEX finora.${IDX}; CREATE ${create.replace("$IDX", IDX)}`;

  // Each variant must keep existing data valid (they are built over real rows),
  // so none is stricter than the real index. `failing` must be false; so must ok.
  it.each([
    ["missing", `DROP INDEX finora.${IDX}`, "present"],
    ["not unique", replace("INDEX $IDX ON finora.financial_accounts (owner_id, name_key)"), "is_unique"],
    ["keys swapped", replace("UNIQUE INDEX $IDX ON finora.financial_accounts (name_key, owner_id)"), "keys_are_owner_id_and_name_key"],
    ["on the name, not the key", replace("UNIQUE INDEX $IDX ON finora.financial_accounts (owner_id, name)"), "keys_are_owner_id_and_name_key"],
    ["an expression over the key", replace("UNIQUE INDEX $IDX ON finora.financial_accounts (owner_id, lower(name_key))"), "keys_are_owner_id_and_name_key"],
    ["partial", replace("UNIQUE INDEX $IDX ON finora.financial_accounts (owner_id, name_key) WHERE archived_at IS NULL"), "keys_are_owner_id_and_name_key"],
    ["extra key column", replace("UNIQUE INDEX $IDX ON finora.financial_accounts (owner_id, name_key, type)"), "keys_are_owner_id_and_name_key"],
    ["INCLUDE column", replace("UNIQUE INDEX $IDX ON finora.financial_accounts (owner_id, name_key) INCLUDE (type)"), "keys_are_owner_id_and_name_key"],
    ["database-default collation", replace(`UNIQUE INDEX $IDX ON finora.financial_accounts (owner_id, name_key COLLATE "default")`), "key_collation_is_c"],
    ["ICU collation", replace(`UNIQUE INDEX $IDX ON finora.financial_accounts (owner_id, name_key COLLATE "und-x-icu")`), "key_collation_is_c"],
    ["key column not C", `ALTER TABLE finora.financial_accounts ALTER COLUMN name_key TYPE text COLLATE "default"`, "key_column_is_c_and_not_null"],
    ["key column nullable", "ALTER TABLE finora.financial_accounts ALTER COLUMN name_key DROP NOT NULL", "key_column_is_c_and_not_null"],
    ["the old lower(name) index back", "CREATE UNIQUE INDEX financial_accounts_owner_name_ci_key ON finora.financial_accounts (owner_id, lower(name))", "no_other_name_index"],
    ["the old exact-name index back", "CREATE UNIQUE INDEX financial_accounts_owner_name_key ON finora.financial_accounts (owner_id, name)", "no_other_name_index"],
    ["on another table", replace("INDEX $IDX ON finora.categories (owner_id, name)"), "on_expected_table"],
  ] as const)("detects a materially different index: %s", async (_label, setup, failing) => {
    const result = await verify(setup);
    expect(result[failing]).toBe(false);
    expect(result.ok).toBe(false);
  });

  it("is restored after the variants (each ran in a rolled-back transaction)", async () => {
    expect((await verify()).ok).toBe(true);
  });
});

describe("account-name key index", () => {
  /** A fresh ledger account of `owner` and an insert of an account with `name`/`key` on it, as `client`. */
  async function insertAccount(client: pg.Client, owner: string, name: string, key: string) {
    const { rows } = await client.query(
      "INSERT INTO finora.ledger_accounts (owner_id, name, kind, currency_code) VALUES ($1, $2, 'asset', 'INR') RETURNING id::text",
      [owner, `itest:key-probe:${randomUUID()}`],
    );
    return client.query(
      `INSERT INTO finora.financial_accounts (owner_id, name, name_key, type, currency_code, ledger_account_id, creation_key, creation_fingerprint)
       VALUES ($1, $2, $3, 'bank', 'INR', $4, $5, repeat('0', 64))`,
      [owner, name, key, rows[0].id, `raw-${randomUUID()}`],
    );
  }

  it("rejects a duplicate key even when every application check is bypassed", async () => {
    // As the runtime role (RLS applies) and as the migration role.
    await expect(asOwner(app, a.ownerId, () => insertAccount(app, a.ownerId, "RAW BANK (raw sql)", "raw bank"))).rejects.toThrow(
      /financial_accounts_owner_name_key_key/,
    );
    await admin.query("BEGIN");
    try {
      await expect(insertAccount(admin, a.ownerId, "Anything", "raw bank")).rejects.toThrow(/financial_accounts_owner_name_key_key/);
    } finally {
      await admin.query("ROLLBACK");
    }
  });

  it("compares keys byte for byte: no locale lower-casing or normalisation in the database", async () => {
    await admin.query("BEGIN");
    try {
      // Each would equal "raw bank" under a case-insensitive or normalising comparison.
      await insertAccount(admin, a.ownerId, "Raw Bank 1", "RAW BANK");
      await insertAccount(admin, a.ownerId, "Raw Bank 2", "raw\u00a0bank");
      const { rows } = await admin.query("SELECT count(*)::int AS n FROM finora.financial_accounts WHERE owner_id = $1 AND name_key = 'raw bank'", [a.ownerId]);
      expect(rows[0].n).toBe(1);
    } finally {
      await admin.query("ROLLBACK");
    }
  });

  it("lets another owner use the same key", async () => {
    await admin.query("BEGIN");
    try {
      await expect(insertAccount(admin, b.ownerId, "Raw bank", "raw bank")).resolves.toBeDefined();
    } finally {
      await admin.query("ROLLBACK");
    }
  });

  it("requires a non-empty key", async () => {
    for (const key of [null, ""]) {
      await admin.query("BEGIN");
      try {
        await expect(insertAccount(admin, a.ownerId, "Keyless", key as string)).rejects.toThrow(/name_key|financial_accounts_name_key_format/);
      } finally {
        await admin.query("ROLLBACK");
      }
    }
  });
});
