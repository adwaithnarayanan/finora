import { describe, expect, it } from "vitest";

import { account, jl } from "./fixtures.test-helpers";
import {
  InvalidIdempotencyKeyError,
  InvalidLedgerInputError,
  canonicalRequest,
  parseIdempotencyKey,
  parseJournalEntryId,
  parseLedgerDate,
} from "./index";

describe("parseIdempotencyKey", () => {
  it.each(["a", "0", "post:2026-10-25:rent", "4f1c_9.A-b", "x".repeat(128), "550e8400-e29b-41d4-a716-446655440000"])(
    "accepts %j",
    (key) => {
      expect(parseIdempotencyKey(key)).toBe(key);
    },
  );

  it.each(["", " key", "key ", "-key", ".key", "x".repeat(129), "a/b", "a b", "ключ", "a\n", 42, null, undefined])(
    "rejects %j",
    (key) => {
      expect(() => parseIdempotencyKey(key)).toThrow(InvalidIdempotencyKeyError);
      expect(() => parseIdempotencyKey(key)).toThrow(InvalidLedgerInputError);
    },
  );
});

describe("canonicalRequest", () => {
  const cash = account("asset");
  const income = account("income");
  const date = parseLedgerDate("2026-10-25");
  const base = {
    kind: "post-entry" as const,
    entryDate: date,
    description: "Salary",
    lines: [jl(cash, "debit", "1.5"), jl(income, "credit", "1.5")],
  };

  it("is deterministic and normalises exact amounts", () => {
    const same = { ...base, lines: [jl(cash, "debit", "1.50"), jl(income, "credit", "1.500")] };
    expect(canonicalRequest(base)).toBe(canonicalRequest(same));
    expect(canonicalRequest(base)).toContain('"150"');
  });

  it.each([
    ["amount", { lines: [jl(cash, "debit", "1.51"), jl(income, "credit", "1.51")] }],
    ["side", { lines: [jl(cash, "credit", "1.5"), jl(income, "debit", "1.5")] }],
    ["line order", { lines: [jl(income, "credit", "1.5"), jl(cash, "debit", "1.5")] }],
    ["memo", { lines: [jl(cash, "debit", "1.5", "memo"), jl(income, "credit", "1.5")] }],
    ["date", { entryDate: parseLedgerDate("2026-10-26") }],
    ["description", { description: "Salary!" }],
    ["operation", { kind: "create-draft" as const }],
  ])("changes when the %s changes", (_label, change) => {
    expect(canonicalRequest({ ...base, ...change })).not.toBe(canonicalRequest(base));
  });

  it("covers reversals and corrections", () => {
    const entryId = parseJournalEntryId("00000000-0000-4000-8000-0000000000ff");
    const reverse = canonicalRequest({ kind: "reverse-entry", entryId, entryDate: date, description: "Undo" });
    const correct = canonicalRequest({
      kind: "correct-entry",
      entryId,
      entryDate: date,
      description: "Undo",
      replacement: base,
    });
    expect(reverse).not.toBe(correct);
    expect(correct).toContain(entryId);
    expect(
      canonicalRequest({ kind: "correct-entry", entryId, entryDate: date, description: "Undo", replacement: { ...base, description: "Other" } }),
    ).not.toBe(correct);
  });
});
