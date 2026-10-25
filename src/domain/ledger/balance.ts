import { Money } from "@/domain/money";

import { type JournalEntry, type LedgerAccount, normalSide } from "./types";

/**
 * An account's balance, derived only from posted lines (never stored).
 * `net` is debits minus credits; `normal` is the same figure signed so that a
 * positive value is a balance on the account's normal side (e.g. a liability
 * with more credits than debits is positive).
 */
export interface AccountBalance {
  readonly debits: Money;
  readonly credits: Money;
  readonly net: Money;
  readonly normal: Money;
}

export function balanceFromTotals(
  account: Pick<LedgerAccount, "kind">,
  debits: Money,
  credits: Money,
): AccountBalance {
  const net = debits.subtract(credits);
  return Object.freeze({
    debits,
    credits,
    net,
    normal: normalSide(account.kind) === "debit" ? net : net.negate(),
  });
}

/**
 * Reconstructs an account's balance from entries. Drafts are ignored: only
 * posted entries have an accounting effect.
 */
export function accountBalance(
  account: Pick<LedgerAccount, "id" | "kind" | "currency">,
  entries: readonly Pick<JournalEntry, "status" | "lines">[],
): AccountBalance {
  let debits = Money.zero(account.currency);
  let credits = Money.zero(account.currency);
  for (const entry of entries) {
    if (entry.status !== "posted") continue;
    for (const line of entry.lines) {
      if (line.accountId !== account.id) continue;
      if (line.side === "debit") debits = debits.add(line.amount);
      else credits = credits.add(line.amount);
    }
  }
  return balanceFromTotals(account, debits, credits);
}
