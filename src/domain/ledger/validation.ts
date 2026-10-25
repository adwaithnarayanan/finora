import { type Currency, Money, MoneyError, sameCurrency } from "@/domain/money";

import { LedgerValidationError } from "./errors";
import { parseMemo } from "./fields";
import { isLedgerAccountId } from "./ids";
import { type JournalLine, type LedgerAccount, SIDES, type Side } from "./types";

/** Upper bound on lines per entry; keeps validation and storage bounded. */
export const MAX_LINES_PER_ENTRY = 200;

/** Largest amount one line can hold: PostgreSQL BIGINT. */
export const MAX_LINE_AMOUNT_MINOR = 9_223_372_036_854_775_807n;

/**
 * A problem with an entry's lines. `line` is the zero-based index of the
 * offending line. Unknown and foreign accounts are deliberately reported the
 * same way (`unknown-account`), so another owner's ids reveal nothing.
 */
export type LedgerIssue =
  | { readonly code: "no-lines" }
  | { readonly code: "too-many-lines"; readonly max: number }
  | { readonly code: "unknown-account"; readonly line: number }
  | { readonly code: "invalid-side"; readonly line: number }
  | { readonly code: "invalid-amount"; readonly line: number; readonly reason: string }
  | { readonly code: "non-positive-amount"; readonly line: number }
  | { readonly code: "amount-too-large"; readonly line: number }
  | { readonly code: "invalid-memo"; readonly line: number }
  | {
      readonly code: "currency-mismatch";
      readonly line: number;
      readonly expected: string;
      readonly actual: string;
    }
  | {
      readonly code: "unbalanced";
      readonly currency: string;
      readonly debits: string;
      readonly credits: string;
    };

/**
 * A line as a caller supplies it. The amount is a decimal string in major
 * units (parsed exactly by the money module) and the currency is explicit:
 * it must equal the account's currency, so a caller can never have an amount
 * silently reinterpreted.
 */
export interface JournalLineInput {
  readonly accountId: string;
  readonly side: string;
  readonly amount: string;
  readonly currency: string;
  readonly memo?: string | null;
}

export type AccountLookup = ReadonlyMap<string, LedgerAccount>;

function isSide(value: unknown): value is Side {
  return (SIDES as readonly unknown[]).includes(value);
}

function countIssues(count: number): LedgerIssue[] {
  if (count === 0) return [{ code: "no-lines" }];
  if (count > MAX_LINES_PER_ENTRY) return [{ code: "too-many-lines", max: MAX_LINES_PER_ENTRY }];
  return [];
}

function amountIssues(amount: Money, line: number): LedgerIssue[] {
  if (!amount.isPositive()) return [{ code: "non-positive-amount", line }];
  if (amount.minor > MAX_LINE_AMOUNT_MINOR) return [{ code: "amount-too-large", line }];
  return [];
}

function currencyIssues(actual: Currency, account: LedgerAccount, line: number): LedgerIssue[] {
  return sameCurrency(actual, account.currency)
    ? []
    : [
        {
          code: "currency-mismatch",
          line,
          expected: account.currency.code,
          actual: actual.code,
        },
      ];
}

/**
 * Turns caller input into journal lines, checking each line on its own
 * (account, side, currency, amount, memo). Balance is not required: drafts may
 * be unbalanced. Throws {@link LedgerValidationError} listing every issue.
 */
export function buildLines(
  inputs: readonly JournalLineInput[],
  accounts: AccountLookup,
): JournalLine[] {
  const issues = countIssues(inputs.length);
  if (issues.length > 0) throw new LedgerValidationError(issues);

  const lines: JournalLine[] = [];
  inputs.forEach((input, line) => {
    const account = isLedgerAccountId(input.accountId) ? accounts.get(input.accountId) : undefined;
    if (!account) {
      issues.push({ code: "unknown-account", line });
      return;
    }
    if (!isSide(input.side)) {
      issues.push({ code: "invalid-side", line });
      return;
    }
    if (input.currency !== account.currency.code) {
      issues.push({
        code: "currency-mismatch",
        line,
        expected: account.currency.code,
        actual: String(input.currency),
      });
      return;
    }
    let amount: Money;
    try {
      amount = Money.parse(input.amount, account.currency);
    } catch (error) {
      if (!(error instanceof MoneyError)) throw error;
      issues.push({ code: "invalid-amount", line, reason: error.name });
      return;
    }
    const lineAmountIssues = amountIssues(amount, line);
    if (lineAmountIssues.length > 0) {
      issues.push(...lineAmountIssues);
      return;
    }
    let memo: string | null;
    try {
      memo = parseMemo(input.memo);
    } catch {
      issues.push({ code: "invalid-memo", line });
      return;
    }
    lines.push(Object.freeze({ accountId: account.id, side: input.side, amount, memo }));
  });

  if (issues.length > 0) throw new LedgerValidationError(issues);
  return lines;
}

/** Checks already-constructed lines against their accounts (structure only). */
export function structuralIssues(
  lines: readonly JournalLine[],
  accounts: AccountLookup,
): LedgerIssue[] {
  const issues = countIssues(lines.length);
  lines.forEach((l, line) => {
    const account = accounts.get(l.accountId);
    if (!account) {
      issues.push({ code: "unknown-account", line });
      return;
    }
    if (!isSide(l.side)) issues.push({ code: "invalid-side", line });
    issues.push(...currencyIssues(l.amount.currency, account, line));
    issues.push(...amountIssues(l.amount, line));
  });
  return issues;
}

export interface CurrencyTotals {
  readonly currency: Currency;
  readonly debits: Money;
  readonly credits: Money;
}

/**
 * Sums debits and credits separately for each currency, in order of first
 * appearance. Currencies are compared by code and exponent.
 */
export function totalsByCurrency(lines: readonly JournalLine[]): CurrencyTotals[] {
  const totals = new Map<string, CurrencyTotals>();
  for (const line of lines) {
    const { currency } = line.amount;
    const key = `${currency.code}/${currency.exponent}`;
    const current = totals.get(key) ?? {
      currency,
      debits: Money.zero(currency),
      credits: Money.zero(currency),
    };
    totals.set(key, {
      currency,
      debits: line.side === "debit" ? current.debits.add(line.amount) : current.debits,
      credits: line.side === "credit" ? current.credits.add(line.amount) : current.credits,
    });
  }
  return [...totals.values()];
}

/** One `unbalanced` issue for each currency whose debits and credits differ. */
export function balanceIssues(lines: readonly JournalLine[]): LedgerIssue[] {
  return totalsByCurrency(lines)
    .filter((t) => !t.debits.equals(t.credits))
    .map((t) => ({
      code: "unbalanced",
      currency: t.currency.code,
      debits: t.debits.toDecimalString(),
      credits: t.credits.toDecimalString(),
    }));
}

/** Every issue that would stop these lines from being posted. */
export function postingIssues(
  lines: readonly JournalLine[],
  accounts: AccountLookup,
): LedgerIssue[] {
  const issues = structuralIssues(lines, accounts);
  return issues.length > 0 ? issues : balanceIssues(lines);
}

/** Throws {@link LedgerValidationError} unless the lines can be posted. */
export function assertPostable(lines: readonly JournalLine[], accounts: AccountLookup): void {
  const issues = postingIssues(lines, accounts);
  if (issues.length > 0) throw new LedgerValidationError(issues);
}
