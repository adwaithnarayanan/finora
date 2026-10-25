import type { AccountKind } from "@/domain/ledger";
import type { Currency } from "@/domain/money";

import { type AccountName, canonicalAccountName } from "./account-name";
import { InvalidFinanceInputError, parseName } from "./text";

/** User-facing account types in this release. */
export const FINANCIAL_ACCOUNT_TYPES = ["bank", "cash", "credit_card"] as const;
export type FinancialAccountType = (typeof FINANCIAL_ACCOUNT_TYPES)[number];

export const ACCOUNT_TYPE_LABELS: Record<FinancialAccountType, string> = {
  bank: "Bank account",
  cash: "Cash",
  credit_card: "Credit card",
};

/** The ledger-account kinds a financial account can be backed by. */
export type AccountClass = Extract<AccountKind, "asset" | "liability">;

/**
 * The one mapping from account type to the kind of its ledger account
 * (ADR 0008). The database's finora.financial_account_ledger_kind() mirrors
 * it, and a test compares the two. Fixed for the life of an account: a type
 * may change only to another type of the same class (bank <-> cash).
 */
export const ACCOUNT_LEDGER_KIND: Readonly<Record<FinancialAccountType, AccountClass>> = Object.freeze({
  bank: "asset",
  cash: "asset",
  credit_card: "liability",
});

/** Currency new accounts get unless another is chosen. */
export const DEFAULT_CURRENCY_CODE = "INR";

export function parseAccountType(value: unknown): FinancialAccountType {
  if (!(FINANCIAL_ACCOUNT_TYPES as readonly unknown[]).includes(value)) {
    throw new InvalidFinanceInputError("Choose bank account, cash or credit card");
  }
  return value as FinancialAccountType;
}

/**
 * Parses the type an existing account of type `current` is being changed
 * to. Only a change within one class is allowed: a credit card stays a credit
 * card, and a bank or cash account never becomes one.
 */
export function parseAccountTypeChange(current: FinancialAccountType, value: unknown): FinancialAccountType {
  const next = parseAccountType(value);
  if (ACCOUNT_LEDGER_KIND[next] !== ACCOUNT_LEDGER_KIND[current]) {
    throw new InvalidFinanceInputError(
      current === "credit_card"
        ? "A credit card cannot be changed to another type"
        : "A bank or cash account cannot be changed to a credit card",
    );
  }
  return next;
}

/**
 * Parses a submitted account name into canonical form (see account-name.ts).
 * The length limit applies to the NFC form, which is what is stored.
 */
export function parseAccountName(value: unknown): AccountName {
  if (typeof value !== "string") throw new InvalidFinanceInputError("Account name is required");
  const name = canonicalAccountName(value);
  parseName(name.display, "Account name");
  return name;
}

/** What the domain needs to know about an account to post against it. */
export interface AccountRef {
  readonly id: string;
  readonly name: string;
  readonly ledgerAccountId: string;
  /** The kind of `ledgerAccountId` (from ACCOUNT_LEDGER_KIND). */
  readonly ledgerKind: AccountClass;
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
