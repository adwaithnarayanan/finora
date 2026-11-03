import { FinanceError } from "@/domain/finance";

/**
 * The account, category or transaction does not exist for this owner. Other
 * owners' records produce exactly the same error, so ids reveal nothing.
 */
export class FinanceNotFoundError extends FinanceError {
  constructor(readonly resource: "account" | "category" | "transaction") {
    super(`${resource[0]!.toUpperCase()}${resource.slice(1)} not found`);
  }
}

export type FinanceConflictReason =
  | "account-name-taken"
  | "category-name-taken"
  | "account-has-history"
  | "opening-balance-exists"
  | "no-opening-balance"
  | "already-voided"
  | "purchase-has-refunds";

const MESSAGES: Record<FinanceConflictReason, string> = {
  "account-name-taken": "You already have an account with that name",
  "category-name-taken": "You already have a category with that name",
  "account-has-history": "This account has history and cannot be deleted; archive it instead",
  "opening-balance-exists": "This account already has an opening balance; correct it instead",
  "no-opening-balance": "This account has no opening balance to correct",
  "already-voided": "This transaction has already been voided or corrected",
  "purchase-has-refunds": "This purchase has refunds recorded against it; void those first",
};

/** The request conflicts with the current state; nothing was changed. */
export class FinanceConflictError extends FinanceError {
  constructor(readonly reason: FinanceConflictReason) {
    super(MESSAGES[reason]);
  }
}
