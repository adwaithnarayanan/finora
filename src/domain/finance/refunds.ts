import { Money, sameCurrency } from "@/domain/money";

import type { AccountRef } from "./accounts";
import type { IssueCollector } from "./errors";
import type { RecordKind } from "./transactions";

/**
 * Card refunds (ADR 0008, Milestone 5D). A refund either refunds a purchase
 * Finora recorded (a *linked* refund) or records a merchant credit whose
 * purchase it never saw (an *unlinked* refund). Only linked refunds are
 * limited by what was paid; an unlinked one has no purchase to measure
 * against and so never enters any purchase's total.
 */

/** What the server resolved about the purchase a refund is linked to. */
export interface PurchaseRef {
  readonly id: string;
  readonly kind: RecordKind;
  /** The account that paid for it: the card itself, for a card purchase. */
  readonly paidByAccountId: string | null;
  readonly amount: Money;
  readonly voided: boolean;
}

/**
 * How much of a purchase may still be refunded: its amount less the refunds
 * that are still active, in exact minor units. Clamped at zero, so a purchase
 * that somehow carries more refunds than it should reads as "nothing left"
 * rather than as a negative allowance.
 */
export function remainingRefundable(amount: Money, refunded: Money): Money {
  const remaining = amount.subtract(refunded);
  return remaining.isNegative() ? Money.zero(amount.currency) : remaining;
}

/**
 * Whether `purchase` can take a refund onto `card` at all: an ordinary
 * expense that this very card paid for, not voided, in the card's currency.
 * A refund of a refund fails here (its kind is not `expense`), which is also
 * why a chain or cycle of refunds cannot be built. The database re-checks
 * every one of these at COMMIT.
 */
export function isRefundablePurchase(purchase: PurchaseRef, card: AccountRef): boolean {
  return (
    purchase.kind === "expense" &&
    !purchase.voided &&
    purchase.paidByAccountId === card.id &&
    sameCurrency(purchase.amount.currency, card.currency)
  );
}

/** Field names the refund checks report against. */
export interface RefundFields {
  readonly link: string;
  readonly amount: string;
}

const DEFAULT_FIELDS: RefundFields = { link: "refundsTransactionId", amount: "amount" };

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
  input: { readonly purchase: PurchaseRef; readonly card: AccountRef; readonly refunded: Money },
  fields: RefundFields = DEFAULT_FIELDS,
): boolean {
  const { purchase, card, refunded } = input;
  // When the account is not a usable credit card at all, THAT is what the
  // owner needs told (planTransaction reports it against the account field).
  // Saying "choose a purchase paid with Axis Savings" instead would point at
  // the wrong field, so nothing is recorded here and false stops the amount
  // check: a caller that finds no issue still has planTransaction to come.
  if (card.ledgerKind !== "liability" || card.archived) return false;
  if (!isRefundablePurchase(purchase, card)) {
    issues.add(fields.link, `Choose a purchase paid with ${card.name} that has not been voided`);
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
  input: { readonly purchase: PurchaseRef; readonly amount: Money; readonly refunded: Money },
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

/** Both checks in order, for callers that have the amount already. */
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
  if (checkRefundablePurchase(issues, input, fields)) checkRefundAmount(issues, input, fields);
}
