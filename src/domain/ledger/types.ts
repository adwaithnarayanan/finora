import type { Currency, Money } from "@/domain/money";

import type { LedgerDate } from "./fields";
import type { JournalEntryId, LedgerAccountId } from "./ids";

export const ACCOUNT_KINDS = ["asset", "liability", "equity", "income", "expense"] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export const SIDES = ["debit", "credit"] as const;
export type Side = (typeof SIDES)[number];

export type EntryStatus = "draft" | "posted";

/** An accounting primitive. Every amount on it is in `currency`. */
export interface LedgerAccount {
  readonly id: LedgerAccountId;
  readonly name: string;
  readonly kind: AccountKind;
  readonly currency: Currency;
}

/**
 * One side of a journal entry. `amount` is always strictly positive; the
 * direction is carried only by `side` (see docs/adr/0005-double-entry-ledger.md).
 */
export interface JournalLine {
  readonly accountId: LedgerAccountId;
  readonly side: Side;
  readonly amount: Money;
  readonly memo: string | null;
}

export interface JournalEntry {
  readonly id: JournalEntryId;
  readonly status: EntryStatus;
  readonly entryDate: LedgerDate;
  readonly description: string;
  readonly lines: readonly JournalLine[];
  readonly idempotencyKey: string | null;
  /** On a reversal: the entry it cancels. */
  readonly reversesEntryId: JournalEntryId | null;
  /** On an original: its reversal, once posted. */
  readonly reversedByEntryId: JournalEntryId | null;
  /** On a replacement: the reversed entry it supersedes. */
  readonly replacesEntryId: JournalEntryId | null;
  readonly replacedByEntryId: JournalEntryId | null;
  readonly createdAt: Date;
  readonly postedAt: Date | null;
}

/** Debit-normal kinds show a positive balance when debits exceed credits. */
export function normalSide(kind: AccountKind): Side {
  return kind === "asset" || kind === "expense" ? "debit" : "credit";
}
