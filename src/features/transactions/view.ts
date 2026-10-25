import "server-only";

import { RECORD_KIND_LABELS, type RecordKind } from "@/domain/finance";
import type { CategoryRecord, FinancialAccountRecord, TransactionRecord } from "@/server/finance";

import { formatLedgerDate, formatMoney } from "../shared/format";

/** Plain, serialisable transaction data for pages. */
export interface TransactionView {
  readonly id: string;
  readonly kind: RecordKind;
  readonly kindLabel: string;
  readonly date: string;
  readonly dateLabel: string;
  readonly title: string;
  readonly accounts: string;
  readonly amount: string;
  /** +1 money in, -1 money out, 0 neither (transfer seen from no account). */
  readonly direction: 1 | -1 | 0;
  readonly payee: string | null;
  readonly note: string | null;
  readonly voided: boolean;
  readonly corrected: boolean;
}

export interface Lookups {
  readonly accounts: ReadonlyMap<string, FinancialAccountRecord>;
  readonly categories: ReadonlyMap<string, CategoryRecord>;
}

const nameOf = (lookups: Lookups, id: string | null) => (id ? (lookups.accounts.get(id)?.name ?? "Deleted account") : "");

/**
 * `perspective`: the account a list is shown for. A transfer then reads as
 * money in or out of that account; elsewhere it is neutral.
 */
export function toTransactionView(t: TransactionRecord, lookups: Lookups, perspective?: string): TransactionView {
  const from = nameOf(lookups, t.sourceAccountId);
  const to = nameOf(lookups, t.destinationAccountId);
  const category = t.categoryId ? (lookups.categories.get(t.categoryId)?.name ?? "Category") : null;
  let direction: 1 | -1 | 0 = t.kind === "expense" ? -1 : t.kind === "transfer" ? 0 : 1;
  if (t.kind === "transfer" && perspective) direction = t.destinationAccountId === perspective ? 1 : -1;
  return {
    id: t.id,
    kind: t.kind,
    kindLabel: RECORD_KIND_LABELS[t.kind],
    date: t.occurredOn,
    dateLabel: formatLedgerDate(t.occurredOn),
    title: category ?? (t.kind === "transfer" ? `${from} → ${to}` : RECORD_KIND_LABELS[t.kind]),
    accounts: t.kind === "transfer" ? `${from} → ${to}` : t.kind === "expense" ? from : to,
    amount: formatMoney(t.amount),
    direction,
    payee: t.payee,
    note: t.note,
    voided: t.voidedAt !== null,
    corrected: t.replacedByTransactionId !== null,
  };
}

export function lookupsFrom(accounts: readonly FinancialAccountRecord[], categories: readonly CategoryRecord[]): Lookups {
  return {
    accounts: new Map(accounts.map((a) => [a.id, a])),
    categories: new Map(categories.map((c) => [c.id, c])),
  };
}
