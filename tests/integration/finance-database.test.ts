import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

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

describe("case-insensitive account-name index", () => {
  it("rejects a case variant even for the migration role", async () => {
    await expect(
      admin.query(
        `INSERT INTO finora.financial_accounts (owner_id, name, type, currency_code, ledger_account_id, creation_key, creation_fingerprint)
         SELECT owner_id, upper(name), type, currency_code, ledger_account_id, 'raw-dup', repeat('0', 64)
           FROM finora.financial_accounts WHERE id = $1`,
        [bankId],
      ),
    ).rejects.toThrow(/financial_accounts_owner_name_ci_key|financial_accounts_ledger_account_key/);
    // Isolate the name rule: a fresh ledger account, same name in another case.
    await admin.query("BEGIN");
    try {
      const { rows } = await admin.query(
        "INSERT INTO finora.ledger_accounts (owner_id, name, kind, currency_code) VALUES ($1, 'itest:ci-probe', 'asset', 'INR') RETURNING id::text",
        [a.ownerId],
      );
      await expect(
        admin.query(
          `INSERT INTO finora.financial_accounts (owner_id, name, type, currency_code, ledger_account_id, creation_key, creation_fingerprint)
           VALUES ($1, 'RAW BANK', 'bank', 'INR', $2, 'raw-ci', repeat('0', 64))`,
          [a.ownerId, rows[0].id],
        ),
      ).rejects.toThrow(/financial_accounts_owner_name_ci_key/);
    } finally {
      await admin.query("ROLLBACK");
    }
  });

  it("the migration refuses to run, changing nothing, when existing names collide", async () => {
    const migration = readFileSync(
      path.join(process.cwd(), "prisma/migrations/20261025000400_account_name_case_insensitive/migration.sql"),
      "utf8",
    );
    // Recreate the pre-migration state inside a transaction that is always rolled back.
    await admin.query("BEGIN");
    try {
      await admin.query("DROP INDEX finora.financial_accounts_owner_name_ci_key");
      const { rows } = await admin.query(
        "INSERT INTO finora.ledger_accounts (owner_id, name, kind, currency_code) VALUES ($1, 'itest:ci-conflict', 'asset', 'INR') RETURNING id::text",
        [a.ownerId],
      );
      await admin.query(
        `INSERT INTO finora.financial_accounts (owner_id, name, type, currency_code, ledger_account_id, creation_key, creation_fingerprint)
         VALUES ($1, 'RAW BANK', 'bank', 'INR', $2, 'raw-conflict', repeat('0', 64))`,
        [a.ownerId, rows[0].id],
      );
      await admin.query("SAVEPOINT before_migration");
      await expect(admin.query(migration)).rejects.toThrow(/1 group\(s\) of account names differ only by letter case/);
      await admin.query("ROLLBACK TO SAVEPOINT before_migration");
      const index = await admin.query("SELECT to_regclass('finora.financial_accounts_owner_name_ci_key') AS idx");
      expect(index.rows[0].idx).toBeNull(); // nothing was created
    } finally {
      await admin.query("ROLLBACK");
    }
    const restored = await admin.query("SELECT to_regclass('finora.financial_accounts_owner_name_ci_key')::text AS idx");
    expect(restored.rows[0].idx).toBe("finora.financial_accounts_owner_name_ci_key");
  });
});
