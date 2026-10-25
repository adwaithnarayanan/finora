import { type Currency, INR, KNOWN_CURRENCIES, Money } from "@/domain/money";

import type { JournalLine, LedgerAccount, Side } from "./types";
import { type AccountKind, parseLedgerAccountId } from "./index";

export const { USD, JPY } = KNOWN_CURRENCIES;

let n = 0;
export function account(kind: AccountKind = "asset", currency: Currency = INR, name?: string): LedgerAccount {
  n += 1;
  const suffix = n.toString(16).padStart(12, "0");
  return {
    id: parseLedgerAccountId(`00000000-0000-4000-8000-${suffix}`),
    name: name ?? `Account ${n}`,
    kind,
    currency,
  };
}

export const lookup = (...accounts: LedgerAccount[]) => new Map(accounts.map((a) => [a.id as string, a]));

export function jl(acc: LedgerAccount, side: Side, amount: string, memo: string | null = null): JournalLine {
  return { accountId: acc.id, side, amount: Money.parse(amount, acc.currency), memo };
}

export const input = (acc: LedgerAccount, side: string, amount: string, currency = acc.currency.code) => ({
  accountId: acc.id as string,
  side,
  amount,
  currency,
});
