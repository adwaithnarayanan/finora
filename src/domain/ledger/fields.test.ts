import { describe, expect, it } from "vitest";

import {
  InvalidLedgerInputError,
  MAX_ACCOUNT_NAME_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  isLedgerAccountId,
  parseAccountName,
  parseDescription,
  parseJournalEntryId,
  parseLedgerAccountId,
  parseLedgerDate,
  parseMemo,
} from "./index";

describe("parseLedgerDate", () => {
  it.each(["2026-10-25", "2024-02-29", "1000-01-01", "9999-12-31"])("accepts %s", (date) => {
    expect(parseLedgerDate(date)).toBe(date);
  });

  it.each(["2026-02-29", "2026-13-01", "2026-00-10", "2026-04-31", "0999-12-31", "26-10-25", "2026-10-25T00:00:00Z", "", 20261025, null])(
    "rejects %j",
    (date) => {
      expect(() => parseLedgerDate(date)).toThrow(InvalidLedgerInputError);
    },
  );
});

describe("text fields", () => {
  it("trims and bounds descriptions and names", () => {
    expect(parseDescription("  Rent  ")).toBe("Rent");
    expect(parseDescription("x".repeat(MAX_DESCRIPTION_LENGTH))).toHaveLength(MAX_DESCRIPTION_LENGTH);
    expect(() => parseDescription("x".repeat(MAX_DESCRIPTION_LENGTH + 1))).toThrow(InvalidLedgerInputError);
    expect(() => parseDescription("   ")).toThrow(InvalidLedgerInputError);
    expect(() => parseDescription(5)).toThrow(/must be a string/);
    expect(parseAccountName(" Cash ")).toBe("Cash");
    expect(() => parseAccountName("x".repeat(MAX_ACCOUNT_NAME_LENGTH + 1))).toThrow(InvalidLedgerInputError);
  });

  it("treats absent and blank memos as null", () => {
    expect(parseMemo(undefined)).toBeNull();
    expect(parseMemo(null)).toBeNull();
    expect(parseMemo("  ")).toBeNull();
    expect(parseMemo(" ok ")).toBe("ok");
    expect(() => parseMemo(7)).toThrow(InvalidLedgerInputError);
  });
});

describe("ids", () => {
  const id = "3f6c1a52-8a3b-4c6e-9d1f-0a2b3c4d5e6f";

  it("accepts canonical UUIDs", () => {
    expect(parseLedgerAccountId(id)).toBe(id);
    expect(parseJournalEntryId(id)).toBe(id);
    expect(isLedgerAccountId(id)).toBe(true);
  });

  it.each(["", "x", id.toUpperCase(), ` ${id}`, "00000000-0000-0000-0000-000000000000", 1, null])("rejects %j", (value) => {
    expect(isLedgerAccountId(value)).toBe(false);
    expect(() => parseLedgerAccountId(value)).toThrow(InvalidLedgerInputError);
    expect(() => parseJournalEntryId(value)).toThrow(InvalidLedgerInputError);
  });
});
