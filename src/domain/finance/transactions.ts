import {
  type JournalLineInput,
  MAX_LINE_AMOUNT_MINOR,
  type LedgerDate,
  parseLedgerDate,
} from "@/domain/ledger";
import { Money, MoneyError, sameCurrency } from "@/domain/money";
import { isCanonicalUuid } from "@/domain/shared/uuid";

import type { AccountRef } from "./accounts";
import type { CategoryKind, CategoryRef } from "./categories";
import { IssueCollector } from "./errors";
import { parseNote, parsePayee } from "./text";

export const TRANSACTION_KINDS = [
  "income",
  "expense",
  "transfer",
  "card_payment",
  "card_refund",
] as const;
export type TransactionKind = (typeof TRANSACTION_KINDS)[number];

export type RecordKind = TransactionKind | "opening_balance";

export const RECORD_KIND_LABELS: Record<RecordKind, string> = {
  income: "Income",
  expense: "Expense",
  transfer: "Transfer",
  card_payment: "Card payment",
  card_refund: "Card refund",
  opening_balance: "Opening balance",
};

export function requiredCategoryKind(kind: RecordKind): CategoryKind | null {
  if (kind === "income") return "income";
  if (kind === "expense" || kind === "card_refund") return "expense";
  return null;
}

export const TWO_SIDED_KINDS: readonly RecordKind[] = [
  "transfer",
  "card_payment",
];
export const isTwoSided = (kind: RecordKind): boolean =>
  TWO_SIDED_KINDS.includes(kind);

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
    }
  | {
      readonly kind: "card_payment";
      readonly amount: string;
      readonly date: LedgerDate;
      readonly sourceAccountId: string;
      readonly destinationAccountId: string;
      readonly note: string | null;
    }
  | {
      readonly kind: "card_refund";
      readonly amount: string;
      readonly date: LedgerDate;
      readonly destinationAccountId: string;
      readonly refundsTransactionId: string | null;
      readonly categoryId: string | null;
      readonly payee: string | null;
      readonly note: string | null;
    };

const AMOUNT_SYNTAX = /^\d{1,19}(\.\d{1,6})?$/;

function requireId(
  issues: IssueCollector,
  field: string,
  value: unknown,
  label: string,
): string {
  if (!isCanonicalUuid(value)) {
    issues.add(field, `Choose ${label}`);
    return "";
  }
  return value;
}

export function parseTransactionIntent(
  raw: Readonly<Record<string, unknown>>,
): TransactionIntent {
  const issues = new IssueCollector();
  const kind = raw["kind"];
  if (!(TRANSACTION_KINDS as readonly unknown[]).includes(kind)) {
    issues.add(
      "kind",
      "Choose income, expense, transfer, card payment or card refund",
    );
    issues.throwIfAny();
  }
  const amountText =
    typeof raw["amount"] === "string" ? raw["amount"].trim() : "";
  if (!AMOUNT_SYNTAX.test(amountText) || /^0+(\.0+)?$/.test(amountText)) {
    issues.add(
      "amount",
      "Enter an amount greater than zero, like 1250 or 1250.50",
    );
  }
  const date = issues.capture("date", () => parseLedgerDate(raw["date"]));
  const note = issues.capture("note", () => parseNote(raw["note"])) ?? null;

  let intent: TransactionIntent | undefined;
  if (kind === "income") {
    const destinationAccountId = requireId(
      issues,
      "destinationAccountId",
      raw["destinationAccountId"],
      "the account receiving the money",
    );
    const categoryId = requireId(
      issues,
      "categoryId",
      raw["categoryId"],
      "an income category",
    );
    const payee =
      issues.capture("payee", () => parsePayee(raw["payee"])) ?? null;
    intent = {
      kind,
      amount: amountText,
      date: date!,
      destinationAccountId,
      categoryId,
      payee,
      note,
    };
  } else if (kind === "expense") {
    const sourceAccountId = requireId(
      issues,
      "sourceAccountId",
      raw["sourceAccountId"],
      "the account paying",
    );
    const categoryId = requireId(
      issues,
      "categoryId",
      raw["categoryId"],
      "an expense category",
    );
    const payee =
      issues.capture("payee", () => parsePayee(raw["payee"])) ?? null;
    intent = {
      kind,
      amount: amountText,
      date: date!,
      sourceAccountId,
      categoryId,
      payee,
      note,
    };
  } else if (kind === "card_refund") {
    const destinationAccountId = requireId(
      issues,
      "destinationAccountId",
      raw["destinationAccountId"],
      "the card the refund went to",
    );
    // `refundMode` states which the client meant, so that choosing "a
    const link = raw["refundsTransactionId"];
    const mode = raw["refundMode"];
    const linked =
      mode === "linked" ||
      (mode !== "unlinked" &&
        link !== undefined &&
        link !== null &&
        link !== "");
    const refundsTransactionId = linked
      ? requireId(
          issues,
          "refundsTransactionId",
          link,
          "the purchase being refunded",
        )
      : null;
    const categoryId = linked
      ? null
      : requireId(
          issues,
          "categoryId",
          raw["categoryId"],
          "the expense category being refunded",
        );
    const payee =
      issues.capture("payee", () => parsePayee(raw["payee"])) ?? null;
    intent = {
      kind,
      amount: amountText,
      date: date!,
      destinationAccountId,
      refundsTransactionId,
      categoryId,
      payee,
      note,
    };
  } else {
    const card = kind === "card_payment";
    const sourceAccountId = requireId(
      issues,
      "sourceAccountId",
      raw["sourceAccountId"],
      card ? "the account paying the card" : "the account sending the money",
    );
    const destinationAccountId = requireId(
      issues,
      "destinationAccountId",
      raw["destinationAccountId"],
      card
        ? "the credit card you are paying"
        : "the account receiving the money",
    );
    if (sourceAccountId && sourceAccountId === destinationAccountId) {
      issues.add("destinationAccountId", "Choose two different accounts");
    }
    const sides = {
      amount: amountText,
      date: date!,
      sourceAccountId,
      destinationAccountId,
      note,
    };
    intent = card
      ? { kind: "card_payment", ...sides }
      : { kind: "transfer", ...sides };
  }
  issues.throwIfAny();
  return intent;
}

export interface ResolvedTransaction {
  readonly source?: AccountRef;
  readonly destination?: AccountRef;
  readonly category?: CategoryRef;
  readonly categoryLedgerAccountId?: string;
}

export interface PostingPlan {
  readonly kind: RecordKind;
  readonly amount: Money;
  readonly date: LedgerDate;
  readonly description: string;
  readonly lines: readonly JournalLineInput[];
}

export function parseAmountFor(
  issues: IssueCollector,
  field: string,
  amount: string,
  account: AccountRef,
): Money | undefined {
  try {
    const money = Money.parse(amount, account.currency);
    if (!money.isPositive())
      issues.add(field, "Enter an amount greater than zero");
    else if (money.minor > MAX_LINE_AMOUNT_MINOR)
      issues.add(field, "That amount is too large");
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

type Expected = "asset" | "card" | "any";

function requireUsable(
  issues: IssueCollector,
  field: string,
  account: AccountRef | undefined,
  expected: Expected,
): account is AccountRef {
  if (!account) {
    issues.add(field, "That account does not exist");
    return false;
  }
  if (account.archived) {
    issues.add(
      field,
      `${account.name} is archived; restore it to record new transactions`,
    );
    return false;
  }
  if (expected === "asset" && account.ledgerKind !== "asset") {
    issues.add(
      field,
      `${account.name} is a credit card; a card can only pay for an expense, be paid by a card payment or be credited by a card refund (transfers involving a card are not supported)`,
    );
    return false;
  }
  if (expected === "card" && account.ledgerKind !== "liability") {
    issues.add(
      field,
      `${account.name} is not a credit card; choose a credit card`,
    );
    return false;
  }
  return true;
}

const line = (
  account: string,
  side: "debit" | "credit",
  amount: Money,
  memo: string | null,
): JournalLineInput => ({
  accountId: account,
  side,
  amount: amount.toDecimalString(),
  currency: amount.currency.code,
  memo,
});

const withPayee = (label: string, joiner: string, payee: string | null) =>
  payee ? `${label} ${joiner} ${payee}` : label;

export function planTransaction(
  intent: TransactionIntent,
  resolved: ResolvedTransaction,
): PostingPlan {
  const issues = new IssueCollector();
  // The account whose currency fixes the amount's precision: the one account
  const accountField =
    intent.kind === "expense" ? "sourceAccountId" : "destinationAccountId";
  const account =
    intent.kind === "expense" ? resolved.source : resolved.destination;
  const expected: Expected =
    intent.kind === "expense"
      ? "any"
      : intent.kind === "card_payment" || intent.kind === "card_refund"
        ? "card"
        : "asset";
  if (!requireUsable(issues, accountField, account, expected))
    issues.throwIfAny();
  const amount = parseAmountFor(issues, "amount", intent.amount, account!);

  if (intent.kind === "transfer" || intent.kind === "card_payment") {
    const card = intent.kind === "card_payment";
    const { source, destination } = resolved;
    if (
      requireUsable(issues, "sourceAccountId", source, "asset") &&
      destination
    ) {
      if (source.id === destination.id)
        issues.add("destinationAccountId", "Choose two different accounts");
      if (!sameCurrency(source.currency, destination.currency)) {
        issues.add(
          "destinationAccountId",
          card
            ? `A card payment needs the card and the paying account in the same currency (${source.currency.code} and ${destination.currency.code}); currency conversion is not supported`
            : `Transfers need accounts in the same currency (${source.currency.code} and ${destination.currency.code}); currency conversion is not supported`,
        );
      }
    }
    issues.throwIfAny();
    return {
      kind: intent.kind,
      amount: amount!,
      date: intent.date,
      description: card ? "Card payment" : "Transfer",
      lines: [
        line(destination!.ledgerAccountId, "debit", amount!, intent.note),
        line(source!.ledgerAccountId, "credit", amount!, null),
      ],
    };
  }

  const category = resolved.category;
  const neededKind = requiredCategoryKind(intent.kind)!;
  if (!category) issues.add("categoryId", "That category does not exist");
  else if (category.kind !== neededKind)
    issues.add("categoryId", `Choose an ${neededKind} category`);
  else if (category.archived)
    issues.add("categoryId", `${category.name} is archived`);
  else if (!resolved.categoryLedgerAccountId)
    issues.add("categoryId", "That category has no ledger account");
  issues.throwIfAny();

  const counter = resolved.categoryLedgerAccountId!;
  if (intent.kind === "income" || intent.kind === "card_refund") {
    return {
      kind: intent.kind,
      amount: amount!,
      date: intent.date,
      description:
        intent.kind === "income"
          ? withPayee("Income", "from", intent.payee)
          : withPayee("Card refund", "from", intent.payee),
      lines: [
        line(account!.ledgerAccountId, "debit", amount!, intent.note),
        line(counter, "credit", amount!, null),
      ],
    };
  }
  return {
    kind: "expense",
    amount: amount!,
    date: intent.date,
    description: withPayee("Expense", "to", intent.payee),
    lines: [
      line(counter, "debit", amount!, intent.note),
      line(account!.ledgerAccountId, "credit", amount!, null),
    ],
  };
}

export function planOpeningBalance(input: {
  readonly account: AccountRef;
  readonly amount: string;
  readonly date: unknown;
  readonly equityLedgerAccountId: string;
}): PostingPlan {
  const issues = new IssueCollector();
  const date = issues.capture("openingDate", () => parseLedgerDate(input.date));
  if (input.account.archived)
    issues.add("openingAmount", `${input.account.name} is archived`);
  const amount = parseAmountFor(
    issues,
    "openingAmount",
    input.amount.trim(),
    input.account,
  );
  issues.throwIfAny();
  return {
    kind: "opening_balance",
    amount: amount!,
    date: date!,
    description: "Opening balance",
    lines:
      input.account.ledgerKind === "liability"
        ? [
            line(input.equityLedgerAccountId, "debit", amount!, null),
            line(input.account.ledgerAccountId, "credit", amount!, null),
          ]
        : [
            line(input.account.ledgerAccountId, "debit", amount!, null),
            line(input.equityLedgerAccountId, "credit", amount!, null),
          ],
  };
}
