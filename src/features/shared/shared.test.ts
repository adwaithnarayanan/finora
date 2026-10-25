import { describe, expect, it } from "vitest";

import { FinanceValidationError } from "@/domain/finance";
import { LedgerValidationError } from "@/domain/ledger";
import { INR, KNOWN_CURRENCIES, Money } from "@/domain/money";
import { FinanceConflictError, FinanceNotFoundError } from "@/server/finance/errors";
import { IdempotencyConflictError, LedgerIntegrityError } from "@/server/ledger/errors";

import { toActionState } from "./errors";
import { formEntries } from "./form-state";
import { formatLedgerDate, formatMoney, todayInIndia } from "./format";

describe("format", () => {
  it("formats money in en-IN with the currency's own digits", () => {
    expect(formatMoney(Money.parse("1234567.5", INR))).toBe("₹12,34,567.50");
    expect(formatMoney(Money.parse("-50", INR))).toBe("-₹50.00");
    expect(formatMoney(Money.parse("1500", KNOWN_CURRENCIES.JPY))).toBe("JP¥1,500");
  });

  it("formats ledger dates without time-zone drift", () => {
    expect(formatLedgerDate("2026-10-01")).toBe("1 Oct 2026");
    expect(formatLedgerDate("2026-12-31")).toBe("31 Dec 2026");
  });

  it("uses India's calendar date for 'today'", () => {
    // 20:00 UTC on 25 Oct is already 26 Oct in India (UTC+05:30).
    expect(todayInIndia(new Date("2026-10-25T20:00:00Z"))).toBe("2026-10-26");
    expect(todayInIndia(new Date("2026-10-25T10:00:00Z"))).toBe("2026-10-25");
  });
});

describe("toActionState", () => {
  it("puts validation issues next to their fields (first message per field)", () => {
    const state = toActionState(
      new FinanceValidationError([
        { field: "amount", message: "Too precise" },
        { field: "amount", message: "Second" },
        { field: "date", message: "Bad date" },
      ]),
    );
    expect(state).toEqual({ error: "Check the highlighted fields.", fieldErrors: { amount: "Too precise", date: "Bad date" } });
  });

  it("shows conflicts and not-found errors as form messages", () => {
    expect(toActionState(new FinanceConflictError("account-name-taken")).error).toMatch(/already have an account/);
    expect(toActionState(new FinanceNotFoundError("account")).error).toBe("Account not found");
    expect(toActionState(new LedgerValidationError([{ code: "no-lines" }])).error).toMatch(/no-lines/);
  });

  it("never exposes integrity or idempotency internals", () => {
    expect(toActionState(new LedgerIntegrityError("posted journal entry is unbalanced")).error).not.toMatch(/unbalanced/);
    expect(toActionState(new IdempotencyConflictError()).error).toMatch(/already submitted/);
  });

  it("rethrows unexpected errors to the error boundary", () => {
    const boom = new Error("connect ECONNREFUSED 127.0.0.1:5432");
    expect(() => toActionState(boom)).toThrow(boom);
  });
});

describe("formEntries", () => {
  it("keeps string fields only", () => {
    const form = new FormData();
    form.set("amount", "10");
    form.set("file", new Blob(["x"]), "x.txt");
    expect(formEntries(form)).toEqual({ amount: "10" });
  });
});
