import { Money, sameCurrency } from "@/domain/money";

import type { AccountRef } from "./accounts";
import type { IssueCollector } from "./errors";
import type { RecordKind } from "./transactions";

export interface PurchaseRef {
  readonly id: string;
  readonly kind: RecordKind;
  readonly paidByAccountId: string | null;
  readonly amount: Money;
  readonly voided: boolean;
}

export function remainingRefundable(amount: Money, refunded: Money): Money {
  const remaining = amount.subtract(refunded);
  return remaining.isNegative() ? Money.zero(amount.currency) : remaining;
}

export function isRefundablePurchase(
  purchase: PurchaseRef,
  card: AccountRef,
): boolean {
  return (
    purchase.kind === "expense" &&
    !purchase.voided &&
    purchase.paidByAccountId === card.id &&
    sameCurrency(purchase.amount.currency, card.currency)
  );
}

export interface RefundFields {
  readonly link: string;
  readonly amount: string;
}

const DEFAULT_FIELDS: RefundFields = {
  link: "refundsTransactionId",
  amount: "amount",
};

/**
 * Records why `purchase` cannot be refunded onto `card` at all: it is not an
 * eligible purchase, or nothing is left of it. Reported against the link
 * field, because no amount could fix it. This runs before the amount is
 * parsed, so an ineligible purchase is never reported as a bad amount or a
 * missing category.
 *
 * Returns true when a refund of some amount is possible, and false both when
 * an issue was recorded and when the account itself is the problem (see
 * below), so the caller must not read false as "an issue was added".
 */
export function checkRefundablePurchase(
  issues: IssueCollector,
  input: {
    readonly purchase: PurchaseRef;
    readonly card: AccountRef;
    readonly refunded: Money;
  },
  fields: RefundFields = DEFAULT_FIELDS,
): boolean {
  const { purchase, card, refunded } = input;
  // When the account is not a usable credit card at all, THAT is what the
  if (card.ledgerKind !== "liability" || card.archived) return false;
  if (!isRefundablePurchase(purchase, card)) {
    issues.add(
      fields.link,
      `Choose a purchase paid with ${card.name} that has not been voided`,
    );
    return false;
  }
  if (remainingRefundable(purchase.amount, refunded).isZero()) {
    issues.add(fields.link, "That purchase has already been refunded in full");
    return false;
  }
  return true;
}

/**
 * Records that `amount` is more than is left of `purchase`, naming what is.
 * `refunded` is the total of the purchase's still-active refunds, read under a
 * lock on the purchase row, so two refunds cannot both pass this check (see
 * ADR 0008, "Card refunds").
 */
export function checkRefundAmount(
  issues: IssueCollector,
  input: {
    readonly purchase: PurchaseRef;
    readonly amount: Money;
    readonly refunded: Money;
  },
  fields: RefundFields = DEFAULT_FIELDS,
): void {
  const remaining = remainingRefundable(input.purchase.amount, input.refunded);
  if (input.amount.compare(remaining) > 0) {
    issues.add(
      fields.amount,
      `Refund at most ${remaining.toDecimalString()} ${remaining.currency.code}, which is what is left of this purchase`,
    );
  }
}

export function checkLinkedRefund(
  issues: IssueCollector,
  input: {
    readonly purchase: PurchaseRef;
    readonly card: AccountRef;
    readonly amount: Money;
    readonly refunded: Money;
  },
  fields: RefundFields = DEFAULT_FIELDS,
): void {
  if (checkRefundablePurchase(issues, input, fields))
    checkRefundAmount(issues, input, fields);
}
