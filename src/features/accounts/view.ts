import "server-only";

import {
  ACCOUNT_LEDGER_KIND,
  ACCOUNT_TYPE_LABELS,
  type AccountClass,
  type FinancialAccountType,
} from "@/domain/finance";
import type { Money } from "@/domain/money";
import type { AccountSummary } from "@/server/finance";

import { formatMoney } from "../shared/format";

export interface AccountView {
  readonly id: string;
  readonly name: string;
  readonly type: FinancialAccountType;
  readonly typeLabel: string;
  readonly ledgerKind: AccountClass;
  readonly currencyCode: string;
  readonly balance: string;
  readonly negative: boolean;
  readonly archived: boolean;
  readonly hasHistory: boolean;
  readonly canDelete: boolean;
}

export function formatAccountBalance(
  ledgerKind: AccountClass,
  balance: Money,
): string {
  if (ledgerKind === "asset") return formatMoney(balance);
  if (balance.isZero()) return `Nothing owed (${formatMoney(balance)})`;
  return balance.isNegative()
    ? `Credit balance ${formatMoney(balance.negate())}`
    : `Owed ${formatMoney(balance)}`;
}

export function toAccountView(summary: AccountSummary): AccountView {
  const { account, balance, hasHistory, lifecycle } = summary;
  const ledgerKind = ACCOUNT_LEDGER_KIND[account.type];
  return {
    id: account.id,
    name: account.name,
    type: account.type,
    typeLabel: ACCOUNT_TYPE_LABELS[account.type],
    ledgerKind,
    currencyCode: account.currency.code,
    balance: formatAccountBalance(ledgerKind, balance),
    negative: ledgerKind === "asset" && balance.isNegative(),
    archived: account.archivedAt !== null,
    hasHistory,
    canDelete: lifecycle.canDelete,
  };
}

export interface AccountOption {
  readonly id: string;
  readonly label: string;
  readonly currencyCode: string;
  readonly exponent: number;
  readonly card: boolean;
}

export function toAccountOptions(
  accounts: readonly AccountSummary[],
): AccountOption[] {
  return accounts
    .filter((a) => a.account.archivedAt === null)
    .map(({ account, balance }) => {
      const ledgerKind = ACCOUNT_LEDGER_KIND[account.type];
      return {
        id: account.id,
        label: `${account.name} (${formatAccountBalance(ledgerKind, balance)})`,
        currencyCode: account.currency.code,
        exponent: account.currency.exponent,
        card: ledgerKind === "liability",
      };
    });
}
