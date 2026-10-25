import { describe, expect, it } from "vitest";

import { INR, Money, defineCurrency } from "@/domain/money";

import { JPY, USD, account, input, jl, lookup } from "./fixtures.test-helpers";
import {
  LedgerValidationError,
  MAX_LINES_PER_ENTRY,
  assertPostable,
  balanceIssues,
  buildLines,
  postingIssues,
  structuralIssues,
  totalsByCurrency,
} from "./index";

const cash = account("asset");
const income = account("income");
const usd = account("asset", USD);
const usdIncome = account("income", USD);
const yen = account("expense", JPY);
const accounts = lookup(cash, income, usd, usdIncome, yen);

function issuesOf(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    if (error instanceof LedgerValidationError) return error.issues;
    throw error;
  }
  throw new Error("expected a LedgerValidationError");
}

describe("buildLines", () => {
  it("parses decimal amounts exactly in each account's currency", () => {
    const lines = buildLines(
      [input(cash, "debit", "1234.50"), input(income, "credit", "1234.5"), input(yen, "debit", "500")],
      accounts,
    );
    expect(lines.map((l) => [l.side, l.amount.minor, l.amount.currency.code])).toEqual([
      ["debit", 123450n, "INR"],
      ["credit", 123450n, "INR"],
      ["debit", 500n, "JPY"],
    ]);
    expect(Object.isFrozen(lines[0])).toBe(true);
  });

  it("normalises memos", () => {
    const [a, b, c] = buildLines(
      [
        { ...input(cash, "debit", "1"), memo: "  note  " },
        { ...input(cash, "debit", "1"), memo: "   " },
        input(cash, "debit", "1"),
      ],
      accounts,
    );
    expect([a!.memo, b!.memo, c!.memo]).toEqual(["note", null, null]);
  });

  it("does not require balance (drafts may be unbalanced)", () => {
    expect(buildLines([input(cash, "debit", "1")], accounts)).toHaveLength(1);
  });

  it.each([
    ["0", "non-positive-amount"],
    ["0.00", "non-positive-amount"],
    ["-1", "non-positive-amount"],
    ["1.001", "invalid-amount"],
    ["1e2", "invalid-amount"],
    ["", "invalid-amount"],
    ["9223372036854775807.01", "amount-too-large"],
  ])("rejects amount %j as %s", (amount, code) => {
    expect(issuesOf(() => buildLines([input(cash, "debit", amount)], accounts))).toEqual([
      expect.objectContaining({ code, line: 0 }),
    ]);
  });

  it("accepts the largest BIGINT amount", () => {
    const [line] = buildLines([input(yen, "debit", "9223372036854775807")], accounts);
    expect(line!.amount.minor).toBe(9_223_372_036_854_775_807n);
  });

  it("rejects number amounts at runtime (no floating point)", () => {
    const bad = { ...input(cash, "debit", "1"), amount: 1.5 as unknown as string };
    expect(issuesOf(() => buildLines([bad], accounts))).toEqual([
      { code: "invalid-amount", line: 0, reason: "InvalidAmountError" },
    ]);
  });

  it("requires the stated currency to match the account", () => {
    expect(issuesOf(() => buildLines([input(cash, "debit", "1", "USD")], accounts))).toEqual([
      { code: "currency-mismatch", line: 0, expected: "INR", actual: "USD" },
    ]);
    expect(issuesOf(() => buildLines([input(cash, "debit", "1", "inr")], accounts))).toEqual([
      expect.objectContaining({ code: "currency-mismatch" }),
    ]);
  });

  it("reports unknown, malformed and foreign accounts identically", () => {
    const stranger = account();
    const issues = issuesOf(() =>
      buildLines(
        [
          input(stranger, "debit", "1"),
          { ...input(cash, "debit", "1"), accountId: "nope" },
          { ...input(cash, "debit", "1"), accountId: cash.id.replace(/^0/, "A") }, // non-canonical case
        ],
        accounts,
      ),
    );
    expect(issues).toEqual([
      { code: "unknown-account", line: 0 },
      { code: "unknown-account", line: 1 },
      { code: "unknown-account", line: 2 },
    ]);
  });

  it.each(["Debit", "dr", "", "both"])("rejects side %j", (side) => {
    expect(issuesOf(() => buildLines([input(cash, side, "1")], accounts))).toEqual([
      { code: "invalid-side", line: 0 },
    ]);
  });

  it("rejects over-long memos", () => {
    expect(
      issuesOf(() => buildLines([{ ...input(cash, "debit", "1"), memo: "x".repeat(501) }], accounts)),
    ).toEqual([{ code: "invalid-memo", line: 0 }]);
  });

  it("reports every problem at once, by line", () => {
    const issues = issuesOf(() =>
      buildLines([input(cash, "debit", "0"), input(income, "credit", "5"), input(cash, "sideways", "1")], accounts),
    );
    expect(issues.map((i) => [i.code, "line" in i ? i.line : null])).toEqual([
      ["non-positive-amount", 0],
      ["invalid-side", 2],
    ]);
  });

  it("requires between 1 and MAX_LINES_PER_ENTRY lines", () => {
    expect(issuesOf(() => buildLines([], accounts))).toEqual([{ code: "no-lines" }]);
    const many = Array.from({ length: MAX_LINES_PER_ENTRY + 1 }, () => input(cash, "debit", "1"));
    expect(issuesOf(() => buildLines(many, accounts))).toEqual([{ code: "too-many-lines", max: MAX_LINES_PER_ENTRY }]);
    expect(buildLines(many.slice(1), accounts)).toHaveLength(MAX_LINES_PER_ENTRY);
  });

  it("rethrows unexpected errors from amount parsing", () => {
    const hostile = {
      ...input(cash, "debit", "1"),
      get amount(): string {
        throw new TypeError("boom");
      },
    };
    expect(() => buildLines([hostile], accounts)).toThrow(TypeError);
  });
});

describe("balancing", () => {
  it("accepts debits equal to credits", () => {
    expect(postingIssues([jl(cash, "debit", "100"), jl(income, "credit", "100")], accounts)).toEqual([]);
  });

  it("accepts many lines on each side", () => {
    const lines = [
      jl(cash, "debit", "33.33"),
      jl(cash, "debit", "33.33"),
      jl(cash, "debit", "33.34"),
      jl(income, "credit", "60"),
      jl(income, "credit", "40"),
    ];
    expect(() => assertPostable(lines, accounts)).not.toThrow();
  });

  it("is exact where floating point is not (0.1 + 0.2 = 0.3)", () => {
    const lines = [jl(cash, "debit", "0.10"), jl(cash, "debit", "0.20"), jl(income, "credit", "0.30")];
    expect(balanceIssues(lines)).toEqual([]);
  });

  it("rejects an off-by-one-paisa entry", () => {
    expect(balanceIssues([jl(cash, "debit", "100.00"), jl(income, "credit", "99.99")])).toEqual([
      { code: "unbalanced", currency: "INR", debits: "100.00", credits: "99.99" },
    ]);
  });

  it("rejects single-sided entries", () => {
    expect(postingIssues([jl(cash, "debit", "5")], accounts)).toEqual([
      { code: "unbalanced", currency: "INR", debits: "5.00", credits: "0.00" },
    ]);
  });

  it("balances each currency independently", () => {
    const crossCurrency = [jl(cash, "debit", "10"), jl(usdIncome, "credit", "10")];
    expect(balanceIssues(crossCurrency).map((i) => i.code === "unbalanced" && i.currency)).toEqual(["INR", "USD"]);

    const both = [
      jl(cash, "debit", "10"),
      jl(income, "credit", "10"),
      jl(usd, "debit", "2.50"),
      jl(usdIncome, "credit", "2.50"),
    ];
    expect(balanceIssues(both)).toEqual([]);
    expect(totalsByCurrency(both).map((t) => [t.currency.code, t.debits.minor, t.credits.minor])).toEqual([
      ["INR", 1000n, 1000n],
      ["USD", 250n, 250n],
    ]);
  });

  it("treats the same code with a different exponent as a different currency", () => {
    const odd = defineCurrency("INR", 3);
    const lines = [
      { accountId: cash.id, side: "debit" as const, amount: Money.ofMinor(1000n, INR), memo: null },
      { accountId: income.id, side: "credit" as const, amount: Money.ofMinor(10000n, odd), memo: null },
    ];
    expect(totalsByCurrency(lines)).toHaveLength(2);
    expect(structuralIssues(lines, accounts)).toEqual([
      { code: "currency-mismatch", line: 1, expected: "INR", actual: "INR" },
    ]);
  });

  it("re-checks constructed lines against their accounts before posting", () => {
    const forged = [
      { accountId: cash.id, side: "debit" as const, amount: Money.ofMinor(0n, INR), memo: null },
      { accountId: account().id, side: "credit" as const, amount: Money.ofMinor(5n, INR), memo: null },
      { accountId: income.id, side: "credit" as const, amount: Money.ofMinor(5n, USD), memo: null },
      { accountId: income.id, side: "up" as never, amount: Money.ofMinor(5n, INR), memo: null },
    ];
    expect(postingIssues(forged, accounts).map((i) => i.code)).toEqual([
      "non-positive-amount",
      "unknown-account",
      "currency-mismatch",
      "invalid-side",
    ]);
    expect(() => assertPostable(forged, accounts)).toThrow(LedgerValidationError);
    expect(() => assertPostable([], accounts)).toThrow(/no-lines/);
  });
});
