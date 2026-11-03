import { describe, expect, it } from "vitest";

import { INR, KNOWN_CURRENCIES } from "@/domain/money";
import { parseLedgerDate } from "@/domain/ledger";

import {
  ACCOUNT_LEDGER_KIND,
  ACCOUNT_TYPE_LABELS,
  type AccountRef,
  type CategoryRef,
  FINANCIAL_ACCOUNT_TYPES,
  DEFAULT_CATEGORIES,
  FinanceValidationError,
  IssueCollector,
  type PurchaseRef,
  RECORD_KIND_LABELS,
  TRANSACTION_KINDS,
  TWO_SIDED_KINDS,
  accountLifecycle,
  checkLinkedRefund,
  checkRefundablePurchase,
  isRefundablePurchase,
  isTwoSided,
  parseAccountType,
  parseAccountTypeChange,
  parseCategoryKind,
  parseName,
  parseNote,
  parsePayee,
  parseTransactionIntent,
  planOpeningBalance,
  planTransaction,
  remainingRefundable,
  requiredCategoryKind,
} from "./index";
import { Money } from "@/domain/money";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const account = (n: number, extra: Partial<AccountRef> = {}): AccountRef => ({
  id: id(n),
  name: `Account ${n}`,
  ledgerAccountId: id(100 + n),
  ledgerKind: "asset",
  currency: INR,
  archived: false,
  ...extra,
});
const category = (
  kind: "income" | "expense",
  extra: Partial<CategoryRef> = {},
): CategoryRef => ({
  id: id(kind === "income" ? 200 : 201),
  name: kind === "income" ? "Salary" : "Groceries",
  kind,
  archived: false,
  ...extra,
});
const card = (n: number, extra: Partial<AccountRef> = {}) =>
  account(n, { name: `Card ${n}`, ledgerKind: "liability", ...extra });
const date = "2026-10-25";

function issuesOf(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    if (error instanceof FinanceValidationError)
      return error.issues.map((i) => i.field);
    throw error;
  }
  throw new Error("expected FinanceValidationError");
}

describe("parseTransactionIntent", () => {
  it("parses an income intent and normalises optional text", () => {
    expect(
      parseTransactionIntent({
        kind: "income",
        amount: " 1250.50 ",
        date,
        destinationAccountId: id(1),
        categoryId: id(200),
        payee: "  Acme  ",
        note: "",
      }),
    ).toEqual({
      kind: "income",
      amount: "1250.50",
      date,
      destinationAccountId: id(1),
      categoryId: id(200),
      payee: "Acme",
      note: null,
    });
  });

  it("parses expense and transfer intents (a transfer has no payee or category)", () => {
    expect(
      parseTransactionIntent({
        kind: "expense",
        amount: "1",
        date,
        sourceAccountId: id(1),
        categoryId: id(201),
      }),
    ).toMatchObject({
      kind: "expense",
      payee: null,
    });
    const transfer = parseTransactionIntent({
      kind: "transfer",
      amount: "1",
      date,
      sourceAccountId: id(1),
      destinationAccountId: id(2),
      categoryId: id(200),
      payee: "ignored",
    });
    expect(transfer).toEqual({
      kind: "transfer",
      amount: "1",
      date,
      sourceAccountId: id(1),
      destinationAccountId: id(2),
      note: null,
    });
  });

  it("parses a card-payment intent (two accounts, no payee, no category)", () => {
    expect(
      parseTransactionIntent({
        kind: "card_payment",
        amount: " 5000 ",
        date,
        sourceAccountId: id(1),
        destinationAccountId: id(2),
        categoryId: id(201),
        payee: "ignored",
        note: "  Oct statement  ",
      }),
    ).toEqual({
      kind: "card_payment",
      amount: "5000",
      date,
      sourceAccountId: id(1),
      destinationAccountId: id(2),
      note: "Oct statement",
    });
  });

  it.each([
    ["a missing paying account", { sourceAccountId: "" }, ["sourceAccountId"]],
    [
      "a missing card",
      { destinationAccountId: "not-a-uuid" },
      ["destinationAccountId"],
    ],
    [
      "the same account twice",
      { sourceAccountId: id(1), destinationAccountId: id(1) },
      ["destinationAccountId"],
    ],
    ["a zero amount", { amount: "0" }, ["amount"]],
    ["a negative amount", { amount: "-5000" }, ["amount"]],
    ["an impossible date", { date: "2026-02-30" }, ["date"]],
  ])("rejects a card payment with %s", (_label, override, fields) => {
    const base = {
      kind: "card_payment",
      amount: "5000",
      date,
      sourceAccountId: id(1),
      destinationAccountId: id(2),
    };
    expect(
      issuesOf(() => parseTransactionIntent({ ...base, ...override })),
    ).toEqual(fields);
  });

  it.each([
    ["unknown kind", { kind: "refund" }, ["kind"]],
    ["zero", { kind: "income", amount: "0.00" }, ["amount"]],
    ["negative", { kind: "income", amount: "-5" }, ["amount"]],
    ["exponent", { kind: "income", amount: "1e3" }, ["amount"]],
    ["grouping", { kind: "income", amount: "1,000" }, ["amount"]],
    ["number type", { kind: "income", amount: 12.5 }, ["amount"]],
    ["bad date", { kind: "income", date: "2026-02-30" }, ["date"]],
    [
      "missing account",
      { kind: "income", destinationAccountId: "" },
      ["destinationAccountId"],
    ],
    [
      "non-UUID category",
      { kind: "expense", categoryId: "groceries" },
      ["categoryId"],
    ],
    ["over-long payee", { kind: "expense", payee: "x".repeat(101) }, ["payee"]],
    ["over-long note", { kind: "income", note: "x".repeat(501) }, ["note"]],
    [
      "same-account transfer",
      { kind: "transfer", sourceAccountId: id(1), destinationAccountId: id(1) },
      ["destinationAccountId"],
    ],
  ])("rejects %s", (_label, override, fields) => {
    const base = {
      amount: "1",
      date,
      destinationAccountId: id(2),
      sourceAccountId: id(1),
      categoryId: id(200),
    };
    expect(
      issuesOf(() => parseTransactionIntent({ ...base, ...override })),
    ).toEqual(fields);
  });
});

describe("posting templates", () => {
  const income = parseTransactionIntent({
    kind: "income",
    amount: "100.50",
    date,
    destinationAccountId: id(1),
    categoryId: id(200),
    payee: "Acme",
    note: "Oct",
  });
  const expense = parseTransactionIntent({
    kind: "expense",
    amount: "40",
    date,
    sourceAccountId: id(1),
    categoryId: id(201),
    payee: "Shop",
  });
  const transfer = parseTransactionIntent({
    kind: "transfer",
    amount: "25",
    date,
    sourceAccountId: id(1),
    destinationAccountId: id(2),
  });
  const cardPayment = parseTransactionIntent({
    kind: "card_payment",
    amount: "5000",
    date,
    sourceAccountId: id(1),
    destinationAccountId: id(2),
  });

  it("income: Dr destination asset, Cr income category", () => {
    const plan = planTransaction(income, {
      destination: account(1),
      category: category("income"),
      categoryLedgerAccountId: id(300),
    });
    expect(plan).toMatchObject({
      kind: "income",
      description: "Income from Acme",
      date,
    });
    expect(plan.amount.minor).toBe(10050n);
    expect(plan.lines).toEqual([
      {
        accountId: id(101),
        side: "debit",
        amount: "100.50",
        currency: "INR",
        memo: "Oct",
      },
      {
        accountId: id(300),
        side: "credit",
        amount: "100.50",
        currency: "INR",
        memo: null,
      },
    ]);
  });

  it("expense: Dr expense category, Cr source asset", () => {
    const plan = planTransaction(expense, {
      source: account(1),
      category: category("expense"),
      categoryLedgerAccountId: id(301),
    });
    expect(plan.description).toBe("Expense to Shop");
    expect(plan.lines.map((l) => [l.accountId, l.side, l.amount])).toEqual([
      [id(301), "debit", "40.00"],
      [id(101), "credit", "40.00"],
    ]);
  });

  it("transfer: Dr destination asset, Cr source asset, no category", () => {
    const plan = planTransaction(transfer, {
      source: account(1),
      destination: account(2),
    });
    expect(plan.description).toBe("Transfer");
    expect(plan.lines.map((l) => [l.accountId, l.side, l.amount])).toEqual([
      [id(102), "debit", "25.00"],
      [id(101), "credit", "25.00"],
    ]);
  });

  it("every plan balances: one debit and one credit of the same amount", () => {
    for (const plan of [
      planTransaction(income, {
        destination: account(1),
        category: category("income"),
        categoryLedgerAccountId: id(300),
      }),
      planTransaction(expense, {
        source: account(1),
        category: category("expense"),
        categoryLedgerAccountId: id(301),
      }),
      planTransaction(transfer, {
        source: account(1),
        destination: account(2),
      }),
      planTransaction(cardPayment, {
        source: account(1),
        destination: card(2),
      }),
    ]) {
      expect(plan.lines.map((l) => l.side).sort()).toEqual(["credit", "debit"]);
      expect(new Set(plan.lines.map((l) => l.amount)).size).toBe(1);
    }
  });

  it.each([
    [
      "missing account",
      () =>
        planTransaction(income, {
          category: category("income"),
          categoryLedgerAccountId: id(300),
        }),
      ["destinationAccountId"],
    ],
    [
      "archived account",
      () =>
        planTransaction(income, {
          destination: account(1, { archived: true }),
          category: category("income"),
          categoryLedgerAccountId: id(300),
        }),
      ["destinationAccountId"],
    ],
    [
      "wrong category kind",
      () =>
        planTransaction(income, {
          destination: account(1),
          category: category("expense"),
          categoryLedgerAccountId: id(300),
        }),
      ["categoryId"],
    ],
    [
      "archived category",
      () =>
        planTransaction(expense, {
          source: account(1),
          category: category("expense", { archived: true }),
          categoryLedgerAccountId: id(301),
        }),
      ["categoryId"],
    ],
    [
      "missing category",
      () => planTransaction(expense, { source: account(1) }),
      ["categoryId"],
    ],
    [
      "unmapped category",
      () =>
        planTransaction(expense, {
          source: account(1),
          category: category("expense"),
        }),
      ["categoryId"],
    ],
    [
      "archived transfer source",
      () =>
        planTransaction(transfer, {
          source: account(1, { archived: true }),
          destination: account(2),
        }),
      ["sourceAccountId"],
    ],
    [
      "missing transfer source",
      () => planTransaction(transfer, { destination: account(2) }),
      ["sourceAccountId"],
    ],
    [
      "same account (resolved)",
      () =>
        planTransaction(transfer, {
          source: account(1),
          destination: account(1),
        }),
      ["destinationAccountId"],
    ],
    [
      "currency mismatch (no FX)",
      () =>
        planTransaction(transfer, {
          source: account(1),
          destination: account(2, { currency: KNOWN_CURRENCIES.USD }),
        }),
      ["destinationAccountId"],
    ],
  ])("rejects %s", (_label, fn, fields) => {
    expect(issuesOf(fn)).toEqual(fields);
  });

  it("expense paid by card: Dr expense category, Cr the card's liability account (amount owed grows)", () => {
    const purchase = parseTransactionIntent({
      kind: "expense",
      amount: "1250",
      date,
      sourceAccountId: id(1),
      categoryId: id(201),
      payee: "Store",
      note: "Shoes",
    });
    const plan = planTransaction(purchase, {
      source: card(1),
      category: category("expense"),
      categoryLedgerAccountId: id(301),
    });
    expect(plan).toMatchObject({
      kind: "expense",
      description: "Expense to Store",
      date,
    });
    expect(plan.amount.minor).toBe(125000n);
    expect(plan.lines).toEqual([
      {
        accountId: id(301),
        side: "debit",
        amount: "1250.00",
        currency: "INR",
        memo: "Shoes",
      },
      {
        accountId: id(101),
        side: "credit",
        amount: "1250.00",
        currency: "INR",
        memo: null,
      },
    ]);
  });

  it("checks a card expense's precision against the card's currency", () => {
    const kwd = card(1, { currency: KNOWN_CURRENCIES.KWD });
    const precise = parseTransactionIntent({
      kind: "expense",
      amount: "1.234",
      date,
      sourceAccountId: id(1),
      categoryId: id(201),
    });
    expect(
      planTransaction(precise, {
        source: kwd,
        category: category("expense"),
        categoryLedgerAccountId: id(301),
      }).lines[1],
    ).toMatchObject({
      amount: "1.234",
      currency: "KWD",
    });
    const tooPrecise = parseTransactionIntent({
      kind: "expense",
      amount: "1.001",
      date,
      sourceAccountId: id(1),
      categoryId: id(201),
    });
    expect(
      issuesOf(() =>
        planTransaction(tooPrecise, {
          source: card(1),
          category: category("expense"),
          categoryLedgerAccountId: id(301),
        }),
      ),
    ).toEqual(["amount"]);
  });

  it.each([
    [
      "an archived card",
      () =>
        planTransaction(expense, {
          source: card(1, { archived: true }),
          category: category("expense"),
          categoryLedgerAccountId: id(301),
        }),
      ["sourceAccountId"],
    ],
    [
      "an archived category",
      () =>
        planTransaction(expense, {
          source: card(1),
          category: category("expense", { archived: true }),
          categoryLedgerAccountId: id(301),
        }),
      ["categoryId"],
    ],
    [
      "an income category",
      () =>
        planTransaction(expense, {
          source: card(1),
          category: category("income"),
          categoryLedgerAccountId: id(300),
        }),
      ["categoryId"],
    ],
    [
      "a category without a ledger account in the card's currency",
      () =>
        planTransaction(expense, {
          source: card(1),
          category: category("expense"),
        }),
      ["categoryId"],
    ],
  ])("refuses a card expense with %s", (_label, fn, fields) => {
    expect(issuesOf(fn)).toEqual(fields);
  });

  it.each([
    [
      "income into a card",
      () =>
        planTransaction(income, {
          destination: card(1),
          category: category("income"),
          categoryLedgerAccountId: id(300),
        }),
      "destinationAccountId",
    ],
    [
      "a transfer from a card",
      () =>
        planTransaction(transfer, { source: card(1), destination: account(2) }),
      "sourceAccountId",
    ],
    [
      "a transfer to a card (a card payment has its own kind)",
      () =>
        planTransaction(transfer, { source: account(1), destination: card(2) }),
      "destinationAccountId",
    ],
    [
      "a transfer between cards",
      () =>
        planTransaction(transfer, { source: card(1), destination: card(2) }),
      "destinationAccountId",
    ],
  ])(
    "refuses %s: a card only pays an expense or is paid by a card payment",
    (_label, fn, field) => {
      try {
        fn();
        throw new Error("expected FinanceValidationError");
      } catch (error) {
        if (!(error instanceof FinanceValidationError)) throw error;
        expect(error.issues).toEqual([
          {
            field,
            message: expect.stringMatching(
              /is a credit card; a card can only pay for an expense/,
            ),
          },
        ]);
      }
    },
  );

  it("card payment: Dr the card's liability account, Cr the paying asset account (amount owed falls)", () => {
    const payment = parseTransactionIntent({
      kind: "card_payment",
      amount: "5000",
      date,
      sourceAccountId: id(1),
      destinationAccountId: id(2),
      note: "Oct statement",
    });
    const plan = planTransaction(payment, {
      source: account(1),
      destination: card(2),
    });
    expect(plan).toMatchObject({
      kind: "card_payment",
      description: "Card payment",
      date,
    });
    expect(plan.amount.minor).toBe(500000n);
    expect(plan.lines).toEqual([
      {
        accountId: id(102),
        side: "debit",
        amount: "5000.00",
        currency: "INR",
        memo: "Oct statement",
      },
      {
        accountId: id(101),
        side: "credit",
        amount: "5000.00",
        currency: "INR",
        memo: null,
      },
    ]);
  });

  it("debits no category and so is neither income nor an expense", () => {
    const plan = planTransaction(cardPayment, {
      source: account(1),
      destination: card(2),
      category: category("expense"),
      categoryLedgerAccountId: id(301),
    });
    expect(plan.kind).toBe("card_payment");
    expect(plan.lines.map((l) => l.accountId)).toEqual([id(102), id(101)]);
    expect(plan.lines.map((l) => l.accountId)).not.toContain(id(301));
  });

  it("pays a card more than is owed without complaint (it becomes a credit balance)", () => {
    const overpayment = parseTransactionIntent({
      kind: "card_payment",
      amount: "999999",
      date,
      sourceAccountId: id(1),
      destinationAccountId: id(2),
    });
    expect(
      planTransaction(overpayment, { source: account(1), destination: card(2) })
        .amount.minor,
    ).toBe(99999900n);
  });

  it("checks the amount's precision against the card's currency", () => {
    const kwd = (n: number) => card(n, { currency: KNOWN_CURRENCIES.KWD });
    const precise = parseTransactionIntent({
      kind: "card_payment",
      amount: "1.234",
      date,
      sourceAccountId: id(1),
      destinationAccountId: id(2),
    });
    expect(
      planTransaction(precise, {
        source: account(1, { currency: KNOWN_CURRENCIES.KWD }),
        destination: kwd(2),
      }).lines,
    ).toEqual([
      {
        accountId: id(102),
        side: "debit",
        amount: "1.234",
        currency: "KWD",
        memo: null,
      },
      {
        accountId: id(101),
        side: "credit",
        amount: "1.234",
        currency: "KWD",
        memo: null,
      },
    ]);
    const tooPrecise = parseTransactionIntent({
      kind: "card_payment",
      amount: "1.001",
      date,
      sourceAccountId: id(1),
      destinationAccountId: id(2),
    });
    expect(
      issuesOf(() =>
        planTransaction(tooPrecise, {
          source: account(1),
          destination: card(2),
        }),
      ),
    ).toEqual(["amount"]);
  });

  it.each([
    [
      "a missing card",
      () => planTransaction(cardPayment, { source: account(1) }),
      ["destinationAccountId"],
    ],
    [
      "a missing paying account",
      () => planTransaction(cardPayment, { destination: card(2) }),
      ["sourceAccountId"],
    ],
    [
      "an archived card",
      () =>
        planTransaction(cardPayment, {
          source: account(1),
          destination: card(2, { archived: true }),
        }),
      ["destinationAccountId"],
    ],
    [
      "an archived paying account",
      () =>
        planTransaction(cardPayment, {
          source: account(1, { archived: true }),
          destination: card(2),
        }),
      ["sourceAccountId"],
    ],
    [
      "a currency mismatch (no FX)",
      () =>
        planTransaction(cardPayment, {
          source: account(1),
          destination: card(2, { currency: KNOWN_CURRENCIES.USD }),
        }),
      ["destinationAccountId"],
    ],
  ])("refuses a card payment with %s", (_label, fn, fields) => {
    expect(issuesOf(fn)).toEqual(fields);
  });

  it("refuses a bank or cash account as the card being paid", () => {
    try {
      planTransaction(cardPayment, {
        source: account(1),
        destination: account(2),
      });
      throw new Error("expected FinanceValidationError");
    } catch (error) {
      if (!(error instanceof FinanceValidationError)) throw error;
      expect(error.issues).toEqual([
        {
          field: "destinationAccountId",
          message: expect.stringMatching(
            /is not a credit card; choose a credit card/,
          ),
        },
      ]);
    }
  });

  it("refuses a card as the paying account, so one card never pays another", () => {
    try {
      planTransaction(cardPayment, { source: card(1), destination: card(2) });
      throw new Error("expected FinanceValidationError");
    } catch (error) {
      if (!(error instanceof FinanceValidationError)) throw error;
      expect(error.issues).toEqual([
        {
          field: "sourceAccountId",
          message: expect.stringMatching(
            /is a credit card; a card can only pay for an expense, be paid by a card payment or be credited by a card refund/,
          ),
        },
      ]);
    }
  });

  it("checks precision and size against the account's currency", () => {
    const jpy = account(1, { currency: KNOWN_CURRENCIES.JPY });
    const precise = parseTransactionIntent({
      kind: "income",
      amount: "10.5",
      date,
      destinationAccountId: id(1),
      categoryId: id(200),
    });
    expect(
      issuesOf(() =>
        planTransaction(precise, {
          destination: jpy,
          category: category("income"),
          categoryLedgerAccountId: id(300),
        }),
      ),
    ).toEqual(["amount"]);
    const tooPrecise = parseTransactionIntent({
      kind: "income",
      amount: "1.001",
      date,
      destinationAccountId: id(1),
      categoryId: id(200),
    });
    expect(
      issuesOf(() =>
        planTransaction(tooPrecise, {
          destination: account(1),
          category: category("income"),
          categoryLedgerAccountId: id(300),
        }),
      ),
    ).toEqual(["amount"]);
    const huge = parseTransactionIntent({
      kind: "income",
      amount: "9223372036854775807",
      date,
      destinationAccountId: id(1),
      categoryId: id(200),
    });
    expect(
      issuesOf(() =>
        planTransaction(huge, {
          destination: account(1),
          category: category("income"),
          categoryLedgerAccountId: id(300),
        }),
      ),
    ).toEqual(["amount"]);
    expect(
      planTransaction(huge, {
        destination: jpy,
        category: category("income"),
        categoryLedgerAccountId: id(300),
      }).amount.minor,
    ).toBe(9223372036854775807n);
  });
});

describe("opening balance template", () => {
  it("asset: debits the account and credits opening-balance equity in the account's currency", () => {
    const plan = planOpeningBalance({
      account: account(1),
      amount: " 25000.5 ",
      date,
      equityLedgerAccountId: id(400),
    });
    expect(plan).toMatchObject({
      kind: "opening_balance",
      description: "Opening balance",
      date,
    });
    expect(plan.lines).toEqual([
      {
        accountId: id(101),
        side: "debit",
        amount: "25000.50",
        currency: "INR",
        memo: null,
      },
      {
        accountId: id(400),
        side: "credit",
        amount: "25000.50",
        currency: "INR",
        memo: null,
      },
    ]);
  });

  it("liability (credit card): debits opening-balance equity and credits the card with the amount owed", () => {
    const plan = planOpeningBalance({
      account: card(1),
      amount: "12000",
      date,
      equityLedgerAccountId: id(400),
    });
    expect(plan).toMatchObject({
      kind: "opening_balance",
      description: "Opening balance",
      date,
    });
    expect(plan.amount.minor).toBe(1200000n);
    expect(plan.lines).toEqual([
      {
        accountId: id(400),
        side: "debit",
        amount: "12000.00",
        currency: "INR",
        memo: null,
      },
      {
        accountId: id(101),
        side: "credit",
        amount: "12000.00",
        currency: "INR",
        memo: null,
      },
    ]);
  });

  it("uses the card's own currency and precision", () => {
    const plan = planOpeningBalance({
      account: card(1, { currency: KNOWN_CURRENCIES.KWD }),
      amount: "1.234",
      date,
      equityLedgerAccountId: id(400),
    });
    expect(plan.lines.map((l) => [l.side, l.amount, l.currency])).toEqual([
      ["debit", "1.234", "KWD"],
      ["credit", "1.234", "KWD"],
    ]);
  });

  it.each([
    ["zero", { amount: "0" }, ["openingAmount"]],
    ["too precise", { amount: "1.001" }, ["openingAmount"]],
    ["bad date", { date: "yesterday" }, ["openingDate"]],
    [
      "archived account",
      { account: account(1, { archived: true }) },
      ["openingAmount"],
    ],
  ])("rejects %s", (_label, override, fields) => {
    expect(
      issuesOf(() =>
        planOpeningBalance({
          account: account(1),
          amount: "10",
          date,
          equityLedgerAccountId: id(400),
          ...override,
        }),
      ),
    ).toEqual(fields);
  });

  it.each([
    [
      "a negative amount owed (never read as a credit balance)",
      { amount: "-500" },
    ],
    ["zero owed", { amount: "0" }],
    ["too precise", { amount: "1.001" }],
    ["an archived card", { account: card(1, { archived: true }) }],
  ])("rejects %s on a card", (_label, override) => {
    expect(
      issuesOf(() =>
        planOpeningBalance({
          account: card(1),
          amount: "10",
          date,
          equityLedgerAccountId: id(400),
          ...override,
        }),
      ),
    ).toEqual(["openingAmount"]);
  });

  it("rejects a negative asset opening balance too", () => {
    expect(
      issuesOf(() =>
        planOpeningBalance({
          account: account(1),
          amount: "-500",
          date,
          equityLedgerAccountId: id(400),
        }),
      ),
    ).toEqual(["openingAmount"]);
  });
});

describe("transaction kinds", () => {
  it("labels every recordable kind, and only those", () => {
    expect(Object.keys(RECORD_KIND_LABELS).sort()).toEqual(
      [...TRANSACTION_KINDS, "opening_balance"].sort(),
    );
    expect(RECORD_KIND_LABELS.card_payment).toBe("Card payment");
    expect(TRANSACTION_KINDS).toContain("card_payment");
  });

  it("counts transfers and card payments as two-sided, and nothing else", () => {
    expect([...TWO_SIDED_KINDS].sort()).toEqual(["card_payment", "transfer"]);
    for (const kind of ["transfer", "card_payment"] as const)
      expect(isTwoSided(kind)).toBe(true);
    for (const kind of ["income", "expense", "opening_balance"] as const)
      expect(isTwoSided(kind)).toBe(false);
  });
});

describe("account classes (ADR 0008)", () => {
  it("maps every account type to exactly one ledger-account kind", () => {
    expect(ACCOUNT_LEDGER_KIND).toEqual({
      bank: "asset",
      cash: "asset",
      credit_card: "liability",
    });
    expect(Object.keys(ACCOUNT_LEDGER_KIND).sort()).toEqual(
      [...FINANCIAL_ACCOUNT_TYPES].sort(),
    );
    expect(Object.keys(ACCOUNT_TYPE_LABELS).sort()).toEqual(
      [...FINANCIAL_ACCOUNT_TYPES].sort(),
    );
    expect(Object.isFrozen(ACCOUNT_LEDGER_KIND)).toBe(true);
  });

  it("allows a type change only within a class", () => {
    expect(parseAccountTypeChange("bank", "cash")).toBe("cash");
    expect(parseAccountTypeChange("cash", "bank")).toBe("bank");
    expect(parseAccountTypeChange("bank", "bank")).toBe("bank");
    expect(parseAccountTypeChange("credit_card", "credit_card")).toBe(
      "credit_card",
    );
    expect(() => parseAccountTypeChange("bank", "credit_card")).toThrow(
      /cannot be changed to a credit card/,
    );
    expect(() => parseAccountTypeChange("cash", "credit_card")).toThrow(
      /cannot be changed to a credit card/,
    );
    expect(() => parseAccountTypeChange("credit_card", "bank")).toThrow(
      /credit card cannot be changed/,
    );
    expect(() => parseAccountTypeChange("credit_card", "cash")).toThrow(
      /credit card cannot be changed/,
    );
    expect(() => parseAccountTypeChange("bank", "loan")).toThrow(
      /bank account, cash or credit card/,
    );
  });
});

describe("account lifecycle", () => {
  it.each([
    [
      { archived: false, hasHistory: false },
      {
        canTransact: true,
        canArchive: true,
        canRestore: false,
        canDelete: true,
      },
    ],
    [
      { archived: false, hasHistory: true },
      {
        canTransact: true,
        canArchive: true,
        canRestore: false,
        canDelete: false,
      },
    ],
    [
      { archived: true, hasHistory: true },
      {
        canTransact: false,
        canArchive: false,
        canRestore: true,
        canDelete: false,
      },
    ],
    [
      { archived: true, hasHistory: false },
      {
        canTransact: false,
        canArchive: false,
        canRestore: true,
        canDelete: true,
      },
    ],
  ])("%j -> %j", (state, expected) => {
    expect(accountLifecycle(state)).toEqual(expected);
  });
});

describe("field parsers", () => {
  it("parses account types and category kinds", () => {
    expect(parseAccountType("bank")).toBe("bank");
    expect(parseAccountType("cash")).toBe("cash");
    expect(parseAccountType("credit_card")).toBe("credit_card");
    for (const bad of ["credit card", "loan", "", null])
      expect(() => parseAccountType(bad)).toThrow(
        /bank account, cash or credit card/,
      );
    expect(parseCategoryKind("income")).toBe("income");
    expect(() => parseCategoryKind("transfer")).toThrow(/income or expense/);
  });

  it("bounds names, payees and notes", () => {
    expect(parseName("  Savings ")).toBe("Savings");
    expect(() => parseName("")).toThrow(/required/);
    expect(() => parseName(undefined, "Account name")).toThrow(
      /Account name is required/,
    );
    expect(() => parseName("x".repeat(61))).toThrow(/at most 60/);
    expect(parsePayee(null)).toBeNull();
    expect(parsePayee("   ")).toBeNull();
    expect(parseNote(" ok ")).toBe("ok");
    expect(() => parseNote(5)).toThrow(/Note is required/);
  });

  it("default categories cover both kinds with unique names", () => {
    const kinds = new Set(DEFAULT_CATEGORIES.map((c) => c.kind));
    expect(kinds).toEqual(new Set(["income", "expense"]));
    expect(
      new Set(DEFAULT_CATEGORIES.map((c) => `${c.kind}:${c.name}`)).size,
    ).toBe(DEFAULT_CATEGORIES.length);
  });

  it("collects issues and records non-Error throws generically", () => {
    const issues = new IssueCollector();
    expect(issues.capture("a", () => 1)).toBe(1);
    issues.capture("b", () => {
      throw "nope";
    });
    expect(() => issues.throwIfAny()).toThrow(FinanceValidationError);
    expect(parseLedgerDate(date)).toBe(date);
  });
});

describe("card refunds", () => {
  const inr = (text: string) => Money.parse(text, INR);
  const refund = (extra: Record<string, unknown> = {}) =>
    parseTransactionIntent({
      kind: "card_refund",
      amount: "500",
      date,
      destinationAccountId: id(2),
      refundMode: "unlinked",
      categoryId: id(201),
      ...extra,
    });
  const linked = (extra: Record<string, unknown> = {}) =>
    parseTransactionIntent({
      kind: "card_refund",
      amount: "500",
      date,
      destinationAccountId: id(2),
      refundMode: "linked",
      refundsTransactionId: id(500),
      ...extra,
    });
  const purchase = (extra: Partial<PurchaseRef> = {}): PurchaseRef => ({
    id: id(500),
    kind: "expense",
    paidByAccountId: id(2),
    amount: inr("1250"),
    voided: false,
    ...extra,
  });
  const expenseCategory = {
    category: category("expense"),
    categoryLedgerAccountId: id(301),
  };

  it("is an offered kind, labelled as a refund, and is not two-sided", () => {
    expect(TRANSACTION_KINDS).toContain("card_refund");
    expect(RECORD_KIND_LABELS.card_refund).toBe("Card refund");
    expect(isTwoSided("card_refund")).toBe(false);
    expect(TWO_SIDED_KINDS).not.toContain("card_refund");
  });

  it("posts to an expense category, never an income one", () => {
    expect(requiredCategoryKind("card_refund")).toBe("expense");
    expect(requiredCategoryKind("expense")).toBe("expense");
    expect(requiredCategoryKind("income")).toBe("income");
    expect(requiredCategoryKind("transfer")).toBeNull();
    expect(requiredCategoryKind("card_payment")).toBeNull();
    expect(requiredCategoryKind("opening_balance")).toBeNull();
  });

  it("debits the card and credits the expense category (the mirror of a card expense)", () => {
    const plan = planTransaction(refund({ note: "Returned the shoes" }), {
      destination: card(2),
      ...expenseCategory,
    });
    expect(plan.kind).toBe("card_refund");
    expect(plan.description).toBe("Card refund");
    expect(plan.lines).toEqual([
      {
        accountId: id(102),
        side: "debit",
        amount: "500.00",
        currency: "INR",
        memo: "Returned the shoes",
      },
      {
        accountId: id(301),
        side: "credit",
        amount: "500.00",
        currency: "INR",
        memo: null,
      },
    ]);
  });

  it("is the exact mirror of the card expense it gives back", () => {
    const spend = parseTransactionIntent({
      kind: "expense",
      amount: "500",
      date,
      sourceAccountId: id(2),
      categoryId: id(201),
    });
    const expense = planTransaction(spend, {
      source: card(2),
      ...expenseCategory,
    });
    const back = planTransaction(refund(), {
      destination: card(2),
      ...expenseCategory,
    });
    expect(back.lines.map((l) => [l.accountId, l.side])).toEqual(
      expense.lines
        .map((l) => [l.accountId, l.side === "debit" ? "credit" : "debit"])
        .reverse(),
    );
  });

  it("carries the merchant as the payee in the entry description", () => {
    expect(
      planTransaction(refund({ payee: "Bata" }), {
        destination: card(2),
        ...expenseCategory,
      }).description,
    ).toBe("Card refund from Bata");
  });

  it("refuses an income category, so a refund can never be filed as income", () => {
    expect(
      issuesOf(() =>
        planTransaction(refund({ categoryId: id(200) }), {
          destination: card(2),
          category: category("income"),
          categoryLedgerAccountId: id(300),
        }),
      ),
    ).toEqual(["categoryId"]);
  });

  it.each([
    [
      "a bank or cash account instead of a card",
      () =>
        planTransaction(refund(), {
          destination: account(2),
          ...expenseCategory,
        }),
      ["destinationAccountId"],
    ],
    [
      "a missing card",
      () => planTransaction(refund(), expenseCategory),
      ["destinationAccountId"],
    ],
    [
      "an archived card",
      () =>
        planTransaction(refund(), {
          destination: card(2, { archived: true }),
          ...expenseCategory,
        }),
      ["destinationAccountId"],
    ],
    [
      "a missing category",
      () => planTransaction(refund(), { destination: card(2) }),
      ["categoryId"],
    ],
    [
      "an archived category",
      () =>
        planTransaction(refund(), {
          destination: card(2),
          category: category("expense", { archived: true }),
          categoryLedgerAccountId: id(301),
        }),
      ["categoryId"],
    ],
  ])("refuses a refund with %s", (_label, fn, fields) => {
    expect(issuesOf(fn)).toEqual(fields);
  });

  it("checks the amount's precision against the card's currency", () => {
    const tooPrecise = refund({ amount: "1.001" });
    expect(
      issuesOf(() =>
        planTransaction(tooPrecise, {
          destination: card(2),
          ...expenseCategory,
        }),
      ),
    ).toEqual(["amount"]);
    const kwd = refund({ amount: "1.234" });
    expect(
      planTransaction(kwd, {
        destination: card(2, { currency: KNOWN_CURRENCIES.KWD }),
        ...expenseCategory,
      }).amount.minor,
    ).toBe(1234n);
  });

  it("takes a linked refund's category from the purchase, so none is submitted", () => {
    const intent = linked({ categoryId: id(200) });
    expect(intent).toMatchObject({
      kind: "card_refund",
      refundsTransactionId: id(500),
      categoryId: null,
    });
  });

  it("asks for a purchase in linked mode and a category in unlinked mode", () => {
    expect(issuesOf(() => linked({ refundsTransactionId: "" }))).toEqual([
      "refundsTransactionId",
    ]);
    expect(issuesOf(() => refund({ categoryId: "" }))).toEqual(["categoryId"]);
    expect(
      parseTransactionIntent({
        kind: "card_refund",
        amount: "500",
        date,
        destinationAccountId: id(2),
        refundsTransactionId: id(500),
      }),
    ).toMatchObject({ refundsTransactionId: id(500), categoryId: null });
  });

  describe("the remaining refundable amount", () => {
    it("is the purchase less its active refunds, and never negative", () => {
      expect(remainingRefundable(inr("1250"), inr("0")).toDecimalString()).toBe(
        "1250.00",
      );
      expect(
        remainingRefundable(inr("1250"), inr("250")).toDecimalString(),
      ).toBe("1000.00");
      expect(
        remainingRefundable(inr("1250"), inr("1250")).toDecimalString(),
      ).toBe("0.00");
      expect(
        remainingRefundable(inr("1250"), inr("2000")).toDecimalString(),
      ).toBe("0.00");
    });

    it("is exact in minor units at every scale", () => {
      const big = Money.ofMinor(9_007_199_254_740_993n, INR);
      expect(remainingRefundable(big, Money.ofMinor(1n, INR)).minor).toBe(
        9_007_199_254_740_992n,
      );
    });
  });

  describe("eligibility of the linked purchase", () => {
    it("accepts an active expense paid by this very card, in its currency", () => {
      expect(isRefundablePurchase(purchase(), card(2))).toBe(true);
    });

    it.each([
      ["a voided purchase", purchase({ voided: true })],
      ["another card's purchase", purchase({ paidByAccountId: id(3) })],
      [
        "a purchase paid from a bank account",
        purchase({ paidByAccountId: id(1) }),
      ],
      [
        "a refund (so no chain or cycle of refunds)",
        purchase({ kind: "card_refund" }),
      ],
      ["a card payment", purchase({ kind: "card_payment" })],
      ["an opening balance", purchase({ kind: "opening_balance" })],
      [
        "a purchase in another currency",
        purchase({ amount: Money.parse("1250", KNOWN_CURRENCIES.USD) }),
      ],
    ])("refuses %s", (_label, p) => {
      expect(isRefundablePurchase(p, card(2))).toBe(false);
    });
  });

  describe("the cumulative limit on a purchase", () => {
    const check = (
      amount: string,
      refunded: string,
      p: PurchaseRef = purchase(),
    ) => {
      const issues = new IssueCollector();
      checkLinkedRefund(issues, {
        purchase: p,
        card: card(2),
        amount: inr(amount),
        refunded: inr(refunded),
      });
      return issuesOf(() => issues.throwIfAny());
    };
    const ok = (
      amount: string,
      refunded: string,
      p: PurchaseRef = purchase(),
    ) => {
      const issues = new IssueCollector();
      checkLinkedRefund(issues, {
        purchase: p,
        card: card(2),
        amount: inr(amount),
        refunded: inr(refunded),
      });
      issues.throwIfAny();
    };

    it("allows a partial refund, and a second one that exactly finishes the purchase", () => {
      expect(() => ok("250", "0")).not.toThrow();
      expect(() => ok("1000", "250")).not.toThrow();
      expect(() => ok("1250", "0")).not.toThrow();
      expect(() => ok("0.01", "1249.99")).not.toThrow();
    });

    it("refuses a refund that would take the total past what was paid", () => {
      expect(check("1251", "0")).toEqual(["amount"]);
      expect(check("1000.01", "250")).toEqual(["amount"]);
      expect(check("0.02", "1249.99")).toEqual(["amount"]);
    });

    it("names what is left, in the purchase's currency", () => {
      const issues = new IssueCollector();
      checkLinkedRefund(issues, {
        purchase: purchase(),
        card: card(2),
        amount: inr("1000"),
        refunded: inr("500"),
      });
      try {
        issues.throwIfAny();
        throw new Error("expected FinanceValidationError");
      } catch (error) {
        if (!(error instanceof FinanceValidationError)) throw error;
        expect(error.issues[0]).toEqual({
          field: "amount",
          message:
            "Refund at most 750.00 INR, which is what is left of this purchase",
        });
      }
    });

    it("refuses any refund of a purchase already refunded in full, against the link", () => {
      expect(check("0.01", "1250")).toEqual(["refundsTransactionId"]);
    });

    it("reports an ineligible purchase against the link, not the amount", () => {
      expect(check("100", "0", purchase({ voided: true }))).toEqual([
        "refundsTransactionId",
      ]);
      expect(check("100", "0", purchase({ kind: "card_refund" }))).toEqual([
        "refundsTransactionId",
      ]);
    });

    it("says nothing when the account is not a usable card: that is the account's problem", () => {
      for (const notACard of [account(2), card(2, { archived: true })]) {
        const issues = new IssueCollector();
        const possible = checkRefundablePurchase(issues, {
          purchase: purchase(),
          card: notACard,
          refunded: inr("0"),
        });
        expect(possible).toBe(false);
        expect(() => issues.throwIfAny()).not.toThrow();
      }
    });
  });
});
