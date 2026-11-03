import type { Currency, Money } from "@/domain/money";

import type { LedgerDate } from "./fields";
import type { JournalEntryId, LedgerAccountId } from "./ids";

export const ACCOUNT_KINDS = [
  "asset",
  "liability",
  "equity",
  "income",
  "expense",
] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export const SIDES = ["debit", "credit"] as const;
export type Side = (typeof SIDES)[number];

export type EntryStatus = "draft" | "posted";

export interface LedgerAccount {
  readonly id: LedgerAccountId;
  readonly name: string;
  readonly kind: AccountKind;
  readonly currency: Currency;
}

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
  readonly reversesEntryId: JournalEntryId | null;
  readonly reversedByEntryId: JournalEntryId | null;
  readonly replacesEntryId: JournalEntryId | null;
  readonly replacedByEntryId: JournalEntryId | null;
  readonly createdAt: Date;
  readonly postedAt: Date | null;
}

export function normalSide(kind: AccountKind): Side {
  return kind === "asset" || kind === "expense" ? "debit" : "credit";
}
