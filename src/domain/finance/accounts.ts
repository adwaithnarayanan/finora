import type { AccountKind } from "@/domain/ledger";
import type { Currency } from "@/domain/money";

import { type AccountName, canonicalAccountName } from "./account-name";
import { InvalidFinanceInputError, parseName } from "./text";

export const FINANCIAL_ACCOUNT_TYPES = ["bank", "cash", "credit_card"] as const;
export type FinancialAccountType = (typeof FINANCIAL_ACCOUNT_TYPES)[number];

export const ACCOUNT_TYPE_LABELS: Record<FinancialAccountType, string> = {
  bank: "Bank account",
  cash: "Cash",
  credit_card: "Credit card",
};

export type AccountClass = Extract<AccountKind, "asset" | "liability">;

export const ACCOUNT_LEDGER_KIND: Readonly<
  Record<FinancialAccountType, AccountClass>
> = Object.freeze({
  bank: "asset",
  cash: "asset",
  credit_card: "liability",
});

export const DEFAULT_CURRENCY_CODE = "INR";

export function parseAccountType(value: unknown): FinancialAccountType {
  if (!(FINANCIAL_ACCOUNT_TYPES as readonly unknown[]).includes(value)) {
    throw new InvalidFinanceInputError(
      "Choose bank account, cash or credit card",
    );
  }
  return value as FinancialAccountType;
}

export function parseAccountTypeChange(
  current: FinancialAccountType,
  value: unknown,
): FinancialAccountType {
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

export function parseAccountName(value: unknown): AccountName {
  if (typeof value !== "string")
    throw new InvalidFinanceInputError("Account name is required");
  const name = canonicalAccountName(value);
  parseName(name.display, "Account name");
  return name;
}

export interface AccountRef {
  readonly id: string;
  readonly name: string;
  readonly ledgerAccountId: string;
  readonly ledgerKind: AccountClass;
  readonly currency: Currency;
  readonly archived: boolean;
}

export interface AccountLifecycle {
  readonly canTransact: boolean;
  readonly canArchive: boolean;
  readonly canRestore: boolean;
  readonly canDelete: boolean;
}

export function accountLifecycle(state: {
  readonly archived: boolean;
  readonly hasHistory: boolean;
}): AccountLifecycle {
  return {
    canTransact: !state.archived,
    canArchive: !state.archived,
    canRestore: state.archived,
    canDelete: !state.hasHistory,
  };
}
