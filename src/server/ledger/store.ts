import type { Currency } from "@/domain/money";
import type {
  AccountKind,
  IdempotencyKey,
  JournalEntry,
  JournalEntryId,
  JournalLine,
  LedgerAccount,
  LedgerAccountId,
  LedgerDate,
} from "@/domain/ledger";

export interface LedgerStore {
  findCurrency(code: string): Promise<Currency | null>;
  findAccounts(ids: readonly LedgerAccountId[]): Promise<LedgerAccount[]>;
  insertAccount(account: {
    name: string;
    kind: AccountKind;
    currency: Currency;
  }): Promise<LedgerAccount | null>;

  /**
   * Inserts a draft. Returns null, without error, when the owner already has an
   * entry with this idempotency key (waiting for a concurrent insert of the
   * same key to commit or roll back first).
   */
  insertDraft(entry: {
    entryDate: LedgerDate;
    description: string;
    idempotency: { key: IdempotencyKey; fingerprint: string } | null;
    reversesEntryId?: JournalEntryId;
    replacesEntryId?: JournalEntryId;
  }): Promise<JournalEntryId | null>;
  findByIdempotencyKey(
    key: IdempotencyKey,
  ): Promise<{ id: JournalEntryId; fingerprint: string } | null>;

  findEntry(id: JournalEntryId): Promise<JournalEntry | null>;
  lockEntry(id: JournalEntryId): Promise<JournalEntry | null>;

  replaceLines(
    entryId: JournalEntryId,
    lines: readonly JournalLine[],
  ): Promise<void>;
  markPosted(entryId: JournalEntryId): Promise<boolean>;

  postedTotals(
    accountId: LedgerAccountId,
  ): Promise<{ debits: bigint; credits: bigint }>;
}
