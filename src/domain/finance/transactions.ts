import { type JournalLineInput, MAX_LINE_AMOUNT_MINOR, type LedgerDate, parseLedgerDate } from "@/domain/ledger";
import { Money, MoneyError, sameCurrency } from "@/domain/money";
import { isCanonicalUuid } from "@/domain/shared/uuid";

import type { AccountRef } from "./accounts";
import type { CategoryRef } from "./categories";
import { IssueCollector } from "./errors";
import { parseNote, parsePayee } from "./text";

/** Ordinary transaction types a user can record. */
export const TRANSACTION_KINDS = ["income", "expense", "transfer"] as const;
export type TransactionKind = (typeof TRANSACTION_KINDS)[number];

/** Every kind a transaction record can have (opening balances are recorded separately). */
export type RecordKind = TransactionKind | "opening_balance";

export const RECORD_KIND_LABELS: Record<RecordKind, string> = {
  income: "Income",
  expense: "Expense",
  transfer: "Transfer",
  opening_balance: "Opening balance",
};

/**
 * What the client may submit: the intent, never journal lines. Ids are
 * references the server resolves under the authorised owner.
 */
export type TransactionIntent =
  | {
      readonly kind: "income";
      readonly amount: string;
      readonly date: LedgerDate;
      readonly destinationAccountId: string;
      readonly categoryId: string;
      readonly payee: string | null;
      readonly note: string | null;
    }
  | {
      readonly kind: "expense";
      readonly amount: string;
      readonly date: LedgerDate;
      readonly sourceAccountId: string;
      readonly categoryId: string;
      readonly payee: string | null;
      readonly note: string | null;
    }
  | {
      readonly kind: "transfer";
      readonly amount: string;
      readonly date: LedgerDate;
      readonly sourceAccountId: string;
      readonly destinationAccountId: string;
      readonly note: string | null;
    };

const AMOUNT_SYNTAX = /^\d{1,19}(\.\d{1,6})?$/;

function requireId(issues: IssueCollector, field: string, value: unknown, label: string): string {
  if (!isCanonicalUuid(value)) {
    issues.add(field, `Choose ${label}`);
    return "";
  }
  return value;
}

/**
 * Validates the shape of a submitted transaction: kind, amount syntax (a plain
 * positive decimal; the currency's precision is checked once the account is
 * known), date, references and optional text. Throws FinanceValidationError
 * listing every issue by field.
 */
export function parseTransactionIntent(raw: Readonly<Record<string, unknown>>): TransactionIntent {
  const issues = new IssueCollector();
  const kind = raw["kind"];
  if (!(TRANSACTION_KINDS as readonly unknown[]).includes(kind)) {
    issues.add("kind", "Choose income, expense or transfer");
    issues.throwIfAny();
  }
  const amountText = typeof raw["amount"] === "string" ? raw["amount"].trim() : "";
  if (!AMOUNT_SYNTAX.test(amountText) || /^0+(\.0+)?$/.test(amountText)) {
    issues.add("amount", "Enter an amount greater than zero, like 1250 or 1250.50");
  }
  const date = issues.capture("date", () => parseLedgerDate(raw["date"]));
  const note = issues.capture("note", () => parseNote(raw["note"])) ?? null;

  let intent: TransactionIntent | undefined;
  if (kind === "income") {
    const destinationAccountId = requireId(issues, "destinationAccountId", raw["destinationAccountId"], "the account receiving the money");
    const categoryId = requireId(issues, "categoryId", raw["categoryId"], "an income category");
    const payee = issues.capture("payee", () => parsePayee(raw["payee"])) ?? null;
    intent = { kind, amount: amountText, date: date!, destinationAccountId, categoryId, payee, note };
  } else if (kind === "expense") {
    const sourceAccountId = requireId(issues, "sourceAccountId", raw["sourceAccountId"], "the account paying");
    const categoryId = requireId(issues, "categoryId", raw["categoryId"], "an expense category");
    const payee = issues.capture("payee", () => parsePayee(raw["payee"])) ?? null;
    intent = { kind, amount: amountText, date: date!, sourceAccountId, categoryId, payee, note };
  } else {
    const sourceAccountId = requireId(issues, "sourceAccountId", raw["sourceAccountId"], "the account sending the money");
    const destinationAccountId = requireId(issues, "destinationAccountId", raw["destinationAccountId"], "the account receiving the money");
    if (sourceAccountId && sourceAccountId === destinationAccountId) {
      issues.add("destinationAccountId", "Choose two different accounts");
    }
    intent = { kind: "transfer", amount: amountText, date: date!, sourceAccountId, destinationAccountId, note };
  }
  issues.throwIfAny();
  return intent;
}

/** Accounts and ledger accounts the server resolved, under the owner, for an intent. */
export interface ResolvedTransaction {
  readonly source?: AccountRef;
  readonly destination?: AccountRef;
  readonly category?: CategoryRef;
  /** The category's ledger account in the transaction's currency (income/expense). */
  readonly categoryLedgerAccountId?: string;
}

export interface PostingPlan {
  readonly kind: RecordKind;
  readonly amount: Money;
  readonly date: LedgerDate;
  /** Entry description (audit text in the journal). */
  readonly description: string;
  readonly lines: readonly JournalLineInput[];
}

/** Parses `amount` exactly in `account`'s currency; it must be positive and fit a ledger line. */
export function parseAmountFor(issues: IssueCollector, field: string, amount: string, account: AccountRef): Money | undefined {
  try {
    const money = Money.parse(amount, account.currency);
    if (!money.isPositive()) issues.add(field, "Enter an amount greater than zero");
    else if (money.minor > MAX_LINE_AMOUNT_MINOR) issues.add(field, "That amount is too large");
    else return money;
  } catch (error) {
    if (!(error instanceof MoneyError)) throw error;
    issues.add(
      field,
      account.currency.exponent === 0
        ? `${account.currency.code} amounts have no decimal places`
        : `Use at most ${account.currency.exponent} decimal places for ${account.currency.code}`,
    );
  }
  return undefined;
}

/**
 * The account exists, is not archived, and can take this side of an ordinary
 * transaction. Bank and cash accounts take any; a credit card can only pay an
 * expense (`cardAllowed`): card payments, refunds, card income and transfers
 * are not supported yet (ADR 0008).
 */
function requireUsable(
  issues: IssueCollector,
  field: string,
  account: AccountRef | undefined,
  cardAllowed = false,
): account is AccountRef {
  if (!account) {
    issues.add(field, "That account does not exist");
    return false;
  }
  if (account.archived) {
    issues.add(field, `${account.name} is archived; restore it to record new transactions`);
    return false;
  }
  if (account.ledgerKind !== "asset" && !cardAllowed) {
    issues.add(
      field,
      `${account.name} is a credit card; a card can only pay for an expense (card payments, refunds and transfers are not supported yet)`,
    );
    return false;
  }
  return true;
}

const line = (account: string, side: "debit" | "credit", amount: Money, memo: string | null): JournalLineInput => ({
  accountId: account,
  side,
  amount: amount.toDecimalString(),
  currency: amount.currency.code,
  memo,
});

const withPayee = (label: string, joiner: string, payee: string | null) => (payee ? `${label} ${joiner} ${payee}` : label);

/**
 * The posting template for each transaction kind. Clients never supply lines:
 *   income    Dr destination asset    Cr category (income)
 *   expense   Dr category (expense)   Cr source (asset, or credit-card liability)
 *   transfer  Dr destination asset    Cr source asset
 * For a card, the credit increases the amount owed (a liability's normal
 * balance), as spending from a bank account decreases what is held.
 * The note travels as the first line's memo, so it is part of the ledger's
 * idempotency fingerprint and audit trail.
 */
export function planTransaction(intent: TransactionIntent, resolved: ResolvedTransaction): PostingPlan {
  const issues = new IssueCollector();
  const accountField = intent.kind === "expense" ? "sourceAccountId" : "destinationAccountId";
  const account = intent.kind === "expense" ? resolved.source : resolved.destination;
  if (!requireUsable(issues, accountField, account, intent.kind === "expense")) issues.throwIfAny();
  const amount = parseAmountFor(issues, "amount", intent.amount, account!);

  if (intent.kind === "transfer") {
    const { source, destination } = resolved;
    if (requireUsable(issues, "sourceAccountId", source) && destination) {
      if (source.id === destination.id) issues.add("destinationAccountId", "Choose two different accounts");
      if (!sameCurrency(source.currency, destination.currency)) {
        issues.add(
          "destinationAccountId",
          `Transfers need accounts in the same currency (${source.currency.code} and ${destination.currency.code}); currency conversion is not supported`,
        );
      }
    }
    issues.throwIfAny();
    return {
      kind: "transfer",
      amount: amount!,
      date: intent.date,
      description: "Transfer",
      lines: [
        line(destination!.ledgerAccountId, "debit", amount!, intent.note),
        line(source!.ledgerAccountId, "credit", amount!, null),
      ],
    };
  }

  const category = resolved.category;
  if (!category) issues.add("categoryId", "That category does not exist");
  else if (category.kind !== intent.kind) issues.add("categoryId", `Choose an ${intent.kind} category`);
  else if (category.archived) issues.add("categoryId", `${category.name} is archived`);
  else if (!resolved.categoryLedgerAccountId) issues.add("categoryId", "That category has no ledger account");
  issues.throwIfAny();

  const counter = resolved.categoryLedgerAccountId!;
  if (intent.kind === "income") {
    return {
      kind: "income",
      amount: amount!,
      date: intent.date,
      description: withPayee("Income", "from", intent.payee),
      lines: [line(account!.ledgerAccountId, "debit", amount!, intent.note), line(counter, "credit", amount!, null)],
    };
  }
  return {
    kind: "expense",
    amount: amount!,
    date: intent.date,
    description: withPayee("Expense", "to", intent.payee),
    lines: [line(counter, "debit", amount!, intent.note), line(account!.ledgerAccountId, "credit", amount!, null)],
  };
}

/**
 * Opening balance: the account's starting position, not income or expense.
 * Recorded in the account's currency against opening-balance equity, on the
 * side that increases the account's normal balance:
 *   asset (bank, cash)         Dr account                  Cr opening-balance equity
 *   liability (credit card)    Dr opening-balance equity   Cr account
 * The amount is positive: money held, or for a card the amount owed. A
 * negative amount is refused, never read as the opposite balance (an opening
 * credit balance on a card is not supported yet).
 */
export function planOpeningBalance(input: {
  readonly account: AccountRef;
  readonly amount: string;
  readonly date: unknown;
  readonly equityLedgerAccountId: string;
}): PostingPlan {
  const issues = new IssueCollector();
  const date = issues.capture("openingDate", () => parseLedgerDate(input.date));
  if (input.account.archived) issues.add("openingAmount", `${input.account.name} is archived`);
  const amount = parseAmountFor(issues, "openingAmount", input.amount.trim(), input.account);
  issues.throwIfAny();
  return {
    kind: "opening_balance",
    amount: amount!,
    date: date!,
    description: "Opening balance",
    lines:
      input.account.ledgerKind === "liability"
        ? [line(input.equityLedgerAccountId, "debit", amount!, null), line(input.account.ledgerAccountId, "credit", amount!, null)]
        : [line(input.account.ledgerAccountId, "debit", amount!, null), line(input.equityLedgerAccountId, "credit", amount!, null)],
  };
}
