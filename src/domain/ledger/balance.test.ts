import { describe, expect, it } from "vitest";

import { Money } from "@/domain/money";

import { USD, account, jl } from "./fixtures.test-helpers";
import { accountBalance, balanceFromTotals, normalSide, reversalLines } from "./index";

const cash = account("asset");
const salary = account("income");
const loan = account("liability");
const usd = account("asset", USD);

describe("normal balance side", () => {
  it.each([
    ["asset", "debit"],
    ["expense", "debit"],
    ["liability", "credit"],
    ["equity", "credit"],
    ["income", "credit"],
  ] as const)("%s accounts are %s-normal", (kind, side) => {
    expect(normalSide(kind)).toBe(side);
  });
});

describe("accountBalance", () => {
  const pay = { status: "posted" as const, lines: [jl(cash, "debit", "50000"), jl(salary, "credit", "50000")] };
  const borrow = { status: "posted" as const, lines: [jl(cash, "debit", "10000"), jl(loan, "credit", "10000")] };
  const spend = { status: "posted" as const, lines: [jl(loan, "debit", "2500.50"), jl(cash, "credit", "2500.50")] };

  it("sums only posted lines of the account", () => {
    const b = accountBalance(cash, [pay, borrow, spend]);
    expect([b.debits.minor, b.credits.minor, b.net.minor, b.normal.minor]).toEqual([
      6_000_000n,
      250_050n,
      5_749_950n,
      5_749_950n,
    ]);
  });

  it("presents credit-normal balances as positive", () => {
    const b = accountBalance(loan, [borrow, spend]);
    expect(b.net.toDecimalString()).toBe("-7499.50");
    expect(b.normal.toDecimalString()).toBe("7499.50");
    expect(accountBalance(salary, [pay]).normal.toDecimalString()).toBe("50000.00");
  });

  it("ignores drafts", () => {
    const draft = { status: "draft" as const, lines: [jl(cash, "debit", "999"), jl(salary, "credit", "999")] };
    expect(accountBalance(cash, [pay, draft]).net.equals(accountBalance(cash, [pay]).net)).toBe(true);
    expect(accountBalance(cash, [draft]).net.isZero()).toBe(true);
  });

  it("returns to zero after a reversal", () => {
    const reversal = { status: "posted" as const, lines: reversalLines(pay) };
    expect(accountBalance(cash, [pay, reversal]).net.isZero()).toBe(true);
    expect(accountBalance(salary, [pay, reversal]).normal.isZero()).toBe(true);
  });

  it("is zero, in the account's currency, with no activity", () => {
    const b = accountBalance(usd, []);
    expect(b.net.isZero()).toBe(true);
    expect(b.net.currency).toBe(USD);
  });

  it("stays exact far beyond Number.MAX_SAFE_INTEGER", () => {
    const huge = Money.ofMinor(9_007_199_254_740_993n, cash.currency);
    const b = balanceFromTotals(cash, huge, Money.ofMinor(1n, cash.currency));
    expect(b.net.minor).toBe(9_007_199_254_740_992n);
    expect(Object.isFrozen(b)).toBe(true);
  });
});
