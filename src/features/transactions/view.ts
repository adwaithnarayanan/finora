import "server-only";

import { ACCOUNT_LEDGER_KIND, RECORD_KIND_LABELS, type RecordKind, isTwoSided } from "@/domain/finance";
import type { CategoryRecord, FinancialAccountRecord, RefundablePurchase, TransactionRecord } from "@/server/finance";

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
  /**
   * The effect on what the owner has: +1 money in (a card refund included:
   * the amount owed falls), -1 money out (including a card's opening amount
   * owed), 0 neither (a transfer or card payment seen from no account).
   */
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
 * `perspective`: the account a list is shown for. A transfer or card payment
 * then reads as money in or out of that account; elsewhere it is neutral
 * (neither changes what the owner is worth). On a card's own page a payment
 * reads as money in, because it reduces what is owed.
 */
export function toTransactionView(t: TransactionRecord, lookups: Lookups, perspective?: string): TransactionView {
  const from = nameOf(lookups, t.sourceAccountId);
  const to = nameOf(lookups, t.destinationAccountId);
  const category = t.categoryId ? (lookups.categories.get(t.categoryId)?.name ?? "Category") : null;
  const twoSided = isTwoSided(t.kind);
  // A refund is money back: the amount owed on the card falls.
  const refund = t.kind === "card_refund";
  let direction: 1 | -1 | 0 = t.kind === "expense" ? -1 : twoSided ? 0 : 1;
  if (twoSided && perspective) direction = t.destinationAccountId === perspective ? 1 : -1;
  const destination = t.destinationAccountId ? lookups.accounts.get(t.destinationAccountId) : undefined;
  if (t.kind === "opening_balance" && destination && ACCOUNT_LEDGER_KIND[destination.type] === "liability") direction = -1;
  return {
    id: t.id,
    kind: t.kind,
    kindLabel: RECORD_KIND_LABELS[t.kind],
    date: t.occurredOn,
    dateLabel: formatLedgerDate(t.occurredOn),
    // A refund names the category it gives back to, marked as a refund so it
    // never reads like another expense in that category.
    title: category ? (refund ? `Refund: ${category}` : category) : twoSided ? `${from} → ${to}` : RECORD_KIND_LABELS[t.kind],
    accounts: twoSided ? `${from} → ${to}` : t.kind === "expense" ? from : to,
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

/**
 * One option in the linked-refund selector. Plain, serialisable data for the
 * client form, which offers only the purchases of the card being credited.
 */
export interface RefundablePurchaseOption {
  readonly id: string;
  /** The card that paid for the purchase. */
  readonly cardAccountId: string;
  readonly label: string;
  /** The category the refund will credit; shown instead of a category picker. */
  readonly categoryLabel: string;
}

/** Purchases with something left to refund, labelled with the remaining amount. */
export function toRefundablePurchaseOptions(
  purchases: readonly RefundablePurchase[],
  lookups: Lookups,
): RefundablePurchaseOption[] {
  return purchases.flatMap(({ purchase, remaining }) => {
    // A card purchase always has a paying account and a category; anything
    // else is not offered rather than mislabelled.
    if (!purchase.sourceAccountId || !purchase.categoryId) return [];
    const categoryLabel = lookups.categories.get(purchase.categoryId)?.name ?? "Category";
    return [
      {
        id: purchase.id,
        cardAccountId: purchase.sourceAccountId,
        categoryLabel,
        label: `${formatLedgerDate(purchase.occurredOn)} · ${categoryLabel}${purchase.payee ? ` · ${purchase.payee}` : ""} · ${formatMoney(purchase.amount)} (${formatMoney(remaining)} left)`,
      },
    ];
  });
}
