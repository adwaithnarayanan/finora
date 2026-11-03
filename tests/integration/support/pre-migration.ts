import { randomUUID } from "node:crypto";

import type pg from "pg";

import type { CategoryKind, RecordKind } from "@/domain/finance";
import { INR, Money } from "@/domain/money";
import type { AuthorizedOwner } from "@/server/auth/types";
import type { createLedgerService } from "@/server/ledger/service";

type LedgerService = ReturnType<typeof createLedgerService>;

export interface RecordedTransaction {
  readonly id: string;
  readonly entryId: string;
}

export interface TransactionRow {
  readonly kind: RecordKind;
  readonly amount: string;
  readonly debit: string;
  readonly credit: string;
  readonly source?: string;
  readonly destination?: string;
  readonly category?: string;
  readonly payee?: string;
  readonly note?: string;
}

export function historyOn(input: {
  readonly db: pg.Client;
  readonly ledger: LedgerService;
  readonly owner: AuthorizedOwner;
  readonly ownerId: string;
  readonly date: string;
}) {
  const { db, ledger, owner, ownerId, date } = input;
  const minorOf = (amount: string) => Money.parse(amount, INR).minor.toString();
  const entryLines = (row: TransactionRow) => [
    {
      accountId: row.debit,
      side: "debit" as const,
      amount: row.amount,
      currency: "INR",
      memo: row.note ?? null,
    },
    {
      accountId: row.credit,
      side: "credit" as const,
      amount: row.amount,
      currency: "INR",
      memo: null,
    },
  ];

  async function insertRow(
    row: TransactionRow,
    entryId: string,
    replaces: string | null,
  ): Promise<RecordedTransaction> {
    const { rows } = await db.query(
      `INSERT INTO finora.transactions (owner_id, kind, occurred_on, amount_minor, currency_code,
         source_account_id, destination_account_id, category_id, payee, note, journal_entry_id, replaces_transaction_id)
       VALUES ($1, $2, $3, $4, 'INR', $5, $6, $7, $8, $9, $10, $11) RETURNING id::text`,
      [
        ownerId,
        row.kind,
        date,
        minorOf(row.amount),
        row.source ?? null,
        row.destination ?? null,
        row.category ?? null,
        row.payee ?? null,
        row.note ?? null,
        entryId,
        replaces,
      ],
    );
    return { id: rows[0]!.id as string, entryId };
  }

  return {
    async mapCategory(categoryId: string, kind: CategoryKind): Promise<string> {
      const account = await ledger.createAccount(owner, {
        name: `category:${categoryId}:INR`,
        kind,
        currency: "INR",
      });
      await db.query(
        "INSERT INTO finora.category_ledger_accounts (owner_id, category_id, currency_code, ledger_account_id) VALUES ($1, $2, 'INR', $3)",
        [ownerId, categoryId, account.id],
      );
      return account.id;
    },

    async openingEquity(): Promise<string> {
      const account = await ledger.createAccount(owner, {
        name: "system:opening-balance-equity:INR",
        kind: "equity",
        currency: "INR",
      });
      await db.query(
        "INSERT INTO finora.system_ledger_accounts (owner_id, purpose, currency_code, ledger_account_id) VALUES ($1, 'opening_balance_equity', 'INR', $2)",
        [ownerId, account.id],
      );
      return account.id;
    },

    async record(row: TransactionRow): Promise<RecordedTransaction> {
      const { entry } = await ledger.postEntry(owner, {
        entryDate: date,
        description: `pre-migration ${row.kind}`,
        idempotencyKey: randomUUID(),
        lines: entryLines(row),
      });
      return insertRow(row, entry.id, null);
    },

    async void(t: RecordedTransaction): Promise<void> {
      const { entry } = await ledger.reverseEntry(owner, t.entryId, {
        entryDate: date,
        description: "Void: pre-migration",
        idempotencyKey: randomUUID(),
      });
      await db.query(
        "UPDATE finora.transactions SET reversal_entry_id = $1 WHERE id = $2",
        [entry.id, t.id],
      );
    },

    async correct(
      t: RecordedTransaction,
      row: TransactionRow,
    ): Promise<RecordedTransaction> {
      const { reversal, replacement } = await ledger.correctEntry(
        owner,
        t.entryId,
        {
          entryDate: date,
          description: "Pre-migration correction",
          idempotencyKey: randomUUID(),
          replacement: {
            entryDate: date,
            description: `pre-migration ${row.kind}`,
            lines: entryLines(row),
          },
        },
      );
      await db.query(
        "UPDATE finora.transactions SET reversal_entry_id = $1 WHERE id = $2",
        [reversal.id, t.id],
      );
      return insertRow(row, replacement.id, t.id);
    },
  };
}
