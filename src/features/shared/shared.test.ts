import { describe, expect, it, vi } from "vitest";

import { FinanceValidationError } from "@/domain/finance";
import { LedgerValidationError } from "@/domain/ledger";
import { INR, KNOWN_CURRENCIES, Money } from "@/domain/money";
import { FinanceConflictError, FinanceNotFoundError } from "@/server/finance/errors";
import { IdempotencyConflictError, LedgerIntegrityError } from "@/server/ledger/errors";

import { toActionState, toActionStateOrFallback } from "./errors";
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

describe("toActionStateOrFallback", () => {
  it("keeps the friendly message for known errors and logs nothing", () => {
    const log = vi.fn();
    expect(toActionStateOrFallback(new FinanceConflictError("account-name-taken"), "Try again.", log).error).toMatch(
      /already have an account/,
    );
    expect(log).not.toHaveBeenCalled();
  });

  it("replaces unexpected errors with the fallback and logs them only on the server", () => {
    const log = vi.fn();
    const boom = new Error('duplicate key value violates unique constraint "categories_owner_kind_name_key"');
    const state = toActionStateOrFallback(boom, "Nothing was changed. Try again.", log);
    expect(state).toEqual({ error: "Nothing was changed. Try again." });
    expect(JSON.stringify(state)).not.toMatch(/constraint|categories_|duplicate key/);
    expect(log).toHaveBeenCalledWith(boom);
  });

  it("logs to the server console by default", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(toActionStateOrFallback(new Error("boom"), "Try again.")).toEqual({ error: "Try again." });
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
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
