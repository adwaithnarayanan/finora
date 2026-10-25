import "server-only";

import { ACCOUNT_TYPE_LABELS, type FinancialAccountType } from "@/domain/finance";
import type { AccountSummary } from "@/server/finance";

import { formatMoney } from "../shared/format";

/** Plain, serialisable account data for pages and client components. */
export interface AccountView {
  readonly id: string;
  readonly name: string;
  readonly type: FinancialAccountType;
  readonly typeLabel: string;
  readonly currencyCode: string;
  readonly balance: string;
  readonly negative: boolean;
  readonly archived: boolean;
  readonly hasHistory: boolean;
  readonly canDelete: boolean;
}

export function toAccountView(summary: AccountSummary): AccountView {
  const { account, balance, hasHistory, lifecycle } = summary;
  return {
    id: account.id,
    name: account.name,
    type: account.type,
    typeLabel: ACCOUNT_TYPE_LABELS[account.type],
    currencyCode: account.currency.code,
    balance: formatMoney(balance),
    negative: balance.isNegative(),
    archived: account.archivedAt !== null,
    hasHistory,
    canDelete: lifecycle.canDelete,
  };
}

/** Options for account pickers: active accounts only. */
export interface AccountOption {
  readonly id: string;
  readonly label: string;
  readonly currencyCode: string;
  readonly exponent: number;
}

export function toAccountOptions(accounts: readonly AccountSummary[]): AccountOption[] {
  return accounts
    .filter((a) => a.account.archivedAt === null)
    .map(({ account, balance }) => ({
      id: account.id,
      label: `${account.name} (${formatMoney(balance)})`,
      currencyCode: account.currency.code,
      exponent: account.currency.exponent,
    }));
}
