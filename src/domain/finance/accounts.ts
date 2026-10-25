import type { Currency } from "@/domain/money";

import { InvalidFinanceInputError } from "./text";

/** User-facing account types in this release. Both are asset accounts in the ledger. */
export const FINANCIAL_ACCOUNT_TYPES = ["bank", "cash"] as const;
export type FinancialAccountType = (typeof FINANCIAL_ACCOUNT_TYPES)[number];

export const ACCOUNT_TYPE_LABELS: Record<FinancialAccountType, string> = {
  bank: "Bank account",
  cash: "Cash",
};

/** Currency new accounts get unless another is chosen. */
export const DEFAULT_CURRENCY_CODE = "INR";

export function parseAccountType(value: unknown): FinancialAccountType {
  if (!(FINANCIAL_ACCOUNT_TYPES as readonly unknown[]).includes(value)) {
    throw new InvalidFinanceInputError("Choose bank account or cash");
  }
  return value as FinancialAccountType;
}

/** What the domain needs to know about an account to post against it. */
export interface AccountRef {
  readonly id: string;
  readonly name: string;
  readonly ledgerAccountId: string;
  readonly currency: Currency;
  readonly archived: boolean;
}

/**
 * What may be done with an account. Accounts with ledger history are kept
 * forever (archive instead of delete); archived accounts take no new
 * ordinary transactions but keep their history and balance.
 */
export interface AccountLifecycle {
  readonly canTransact: boolean;
  readonly canArchive: boolean;
  readonly canRestore: boolean;
  readonly canDelete: boolean;
}

export function accountLifecycle(state: { readonly archived: boolean; readonly hasHistory: boolean }): AccountLifecycle {
  return {
    canTransact: !state.archived,
    canArchive: !state.archived,
    canRestore: state.archived,
    canDelete: !state.hasHistory,
  };
}
