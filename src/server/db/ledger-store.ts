import {
  type IdempotencyKey,
  type JournalEntry,
  type JournalEntryId,
  type JournalLine,
  type LedgerAccount,
  type LedgerAccountId,
  type LedgerDate,
  parseJournalEntryId,
  parseLedgerAccountId,
  parseLedgerDate,
} from "@/domain/ledger";
import { type Currency, Money, defineCurrency } from "@/domain/money";
import type { OwnerId } from "@/domain/owner";
import type { LedgerStore } from "@/server/ledger/store";

import type { ScopedTx } from "./scope";

/** `@db.Date` columns arrive as UTC-midnight Dates. */
const fromDate = (date: Date) => parseLedgerDate(date.toISOString().slice(0, 10));

const toCurrency = (row: { code: string; exponent: number }): Currency =>
  defineCurrency(row.code, row.exponent);

const accountSelect = {
  id: true,
  name: true,
  kind: true,
  currency: { select: { code: true, exponent: true } },
} as const;

function toAccount(row: {
  id: string;
  name: string;
  kind: LedgerAccount["kind"];
  currency: { code: string; exponent: number };
}): LedgerAccount {
  return Object.freeze({
    id: parseLedgerAccountId(row.id),
    name: row.name,
    kind: row.kind,
    currency: toCurrency(row.currency),
  });
}

const optionalId = (row: { id: string } | null) => (row ? parseJournalEntryId(row.id) : null);

/**
 * Prisma implementation of the ledger store. Constructed per owner-scoped
 * transaction (see `withLedgerStore`); RLS filters every statement, and
 * inserts carry the same owner id the RLS context holds (WITH CHECK).
 */
export class PrismaLedgerStore implements LedgerStore {
  constructor(
    private readonly tx: ScopedTx,
    private readonly ownerId: OwnerId,
  ) {}

  async findCurrency(code: string): Promise<Currency | null> {
    const row = await this.tx.currency.findUnique({ where: { code } });
    return row ? toCurrency(row) : null;
  }

  async findAccounts(ids: readonly LedgerAccountId[]): Promise<LedgerAccount[]> {
    if (ids.length === 0) return [];
    const rows = await this.tx.ledgerAccount.findMany({
      where: { id: { in: [...ids] } },
      select: accountSelect,
    });
    return rows.map(toAccount);
  }

  async insertAccount(account: {
    name: string;
    kind: LedgerAccount["kind"];
    currency: Currency;
  }): Promise<LedgerAccount | null> {
    const inserted = await this.tx.$queryRaw<{ id: string }[]>`
      INSERT INTO finora.ledger_accounts (owner_id, name, kind, currency_code)
      VALUES (${this.ownerId}::uuid, ${account.name}, ${account.kind}::finora.ledger_account_kind, ${account.currency.code})
      ON CONFLICT (owner_id, name) DO NOTHING
      RETURNING id::text`;
    const id = inserted[0]?.id;
    if (!id) return null;
    const row = await this.tx.ledgerAccount.findUniqueOrThrow({ where: { id }, select: accountSelect });
    return toAccount(row);
  }

  async insertDraft(entry: {
    entryDate: LedgerDate;
    description: string;
    idempotency: { key: IdempotencyKey; fingerprint: string } | null;
    reversesEntryId?: JournalEntryId;
    replacesEntryId?: JournalEntryId;
  }): Promise<JournalEntryId | null> {
    // ON CONFLICT waits for a concurrent insert of the same key to finish, then
    // inserts nothing if it committed. Only the idempotency key is a conflict
    // target; any other unique violation still raises.
    const inserted = await this.tx.$queryRaw<{ id: string }[]>`
      INSERT INTO finora.journal_entries
        (owner_id, entry_date, description, idempotency_key, idempotency_fingerprint,
         reverses_entry_id, replaces_entry_id)
      VALUES (${this.ownerId}::uuid, ${entry.entryDate}::date, ${entry.description},
              ${entry.idempotency?.key ?? null}, ${entry.idempotency?.fingerprint ?? null},
              ${entry.reversesEntryId ?? null}::uuid, ${entry.replacesEntryId ?? null}::uuid)
      ON CONFLICT (owner_id, idempotency_key) DO NOTHING
      RETURNING id::text`;
    const id = inserted[0]?.id;
    return id ? parseJournalEntryId(id) : null;
  }

  async findByIdempotencyKey(
    key: IdempotencyKey,
  ): Promise<{ id: JournalEntryId; fingerprint: string } | null> {
    const row = await this.tx.journalEntry.findUnique({
      where: { ownerId_idempotencyKey: { ownerId: this.ownerId, idempotencyKey: key } },
      select: { id: true, idempotencyFingerprint: true },
    });
    if (!row || row.idempotencyFingerprint === null) return null;
    return { id: parseJournalEntryId(row.id), fingerprint: row.idempotencyFingerprint };
  }

  async findEntry(id: JournalEntryId): Promise<JournalEntry | null> {
    const row = await this.tx.journalEntry.findUnique({
      where: { id },
      include: {
        lines: {
          orderBy: { lineNo: "asc" },
          include: { account: { select: { currency: { select: { code: true, exponent: true } } } } },
        },
        reversedBy: { select: { id: true } },
        replacedBy: { select: { id: true } },
      },
    });
    if (!row) return null;
    const lines: JournalLine[] = row.lines.map((line) =>
      Object.freeze({
        accountId: parseLedgerAccountId(line.accountId),
        side: line.side,
        amount: Money.ofMinor(line.amountMinor, toCurrency(line.account.currency)),
        memo: line.memo,
      }),
    );
    return Object.freeze({
      id: parseJournalEntryId(row.id),
      status: row.status,
      entryDate: fromDate(row.entryDate),
      description: row.description,
      lines: Object.freeze(lines),
      idempotencyKey: row.idempotencyKey,
      reversesEntryId: row.reversesEntryId ? parseJournalEntryId(row.reversesEntryId) : null,
      reversedByEntryId: optionalId(row.reversedBy),
      replacesEntryId: row.replacesEntryId ? parseJournalEntryId(row.replacesEntryId) : null,
      replacedByEntryId: optionalId(row.replacedBy),
      createdAt: row.createdAt,
      postedAt: row.postedAt,
    });
  }

  async lockEntry(id: JournalEntryId): Promise<JournalEntry | null> {
    const locked = await this.tx.$queryRaw<{ id: string }[]>`
      SELECT id::text FROM finora.journal_entries WHERE id = ${id}::uuid FOR UPDATE`;
    return locked.length === 0 ? null : this.findEntry(id);
  }

  async replaceLines(entryId: JournalEntryId, lines: readonly JournalLine[]): Promise<void> {
    await this.tx.journalLine.deleteMany({ where: { entryId } });
    if (lines.length === 0) return;
    await this.tx.journalLine.createMany({
      data: lines.map((line, index) => ({
        ownerId: this.ownerId,
        entryId,
        lineNo: index + 1,
        accountId: line.accountId,
        currencyCode: line.amount.currency.code,
        side: line.side,
        amountMinor: line.amount.minor,
        memo: line.memo,
      })),
    });
  }

  async markPosted(entryId: JournalEntryId): Promise<boolean> {
    const { count } = await this.tx.journalEntry.updateMany({
      where: { id: entryId, status: "draft" },
      data: { status: "posted" },
    });
    return count === 1;
  }

  async postedTotals(accountId: LedgerAccountId): Promise<{ debits: bigint; credits: bigint }> {
    // SUM over BIGINT yields NUMERIC (no overflow); read it back as text.
    const [row] = await this.tx.$queryRaw<{ debits: string; credits: string }[]>`
      SELECT coalesce(sum(l.amount_minor) FILTER (WHERE l.side = 'debit'), 0)::text AS debits,
             coalesce(sum(l.amount_minor) FILTER (WHERE l.side = 'credit'), 0)::text AS credits
        FROM finora.journal_lines AS l
        JOIN finora.journal_entries AS e ON e.id = l.entry_id AND e.owner_id = l.owner_id
       WHERE l.account_id = ${accountId}::uuid AND e.status = 'posted'`;
    return { debits: BigInt(row?.debits ?? "0"), credits: BigInt(row?.credits ?? "0") };
  }
}
