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

/**
 * Persistence port for the ledger service. Every instance is bound to one
 * owner-scoped transaction (RLS context already set), so implementations
 * never take an owner id from callers and every read is owner-filtered.
 */
export interface LedgerStore {
  findCurrency(code: string): Promise<Currency | null>;
  /** Accounts visible to the owner; unknown or foreign ids are simply absent. */
  findAccounts(ids: readonly LedgerAccountId[]): Promise<LedgerAccount[]>;
  /** Returns null when the owner already has an account with this name. */
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
  /** Like findEntry, but first takes a row lock held until the transaction ends. */
  lockEntry(id: JournalEntryId): Promise<JournalEntry | null>;

  /** Replaces all lines of a draft (numbered in order from 1). */
  replaceLines(entryId: JournalEntryId, lines: readonly JournalLine[]): Promise<void>;
  /** Draft -> posted. Returns false if the entry was not a draft. */
  markPosted(entryId: JournalEntryId): Promise<boolean>;

  /** Sums of posted debit and credit lines on an account, in minor units. */
  postedTotals(accountId: LedgerAccountId): Promise<{ debits: bigint; credits: bigint }>;
}
