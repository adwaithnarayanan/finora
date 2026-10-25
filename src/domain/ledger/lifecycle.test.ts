import { describe, expect, it } from "vitest";

import { account, jl, lookup } from "./fixtures.test-helpers";
import {
  EntryAlreadyReversedError,
  EntryNotDraftError,
  EntryNotReversibleError,
  LedgerError,
  LedgerValidationError,
  assertCanPost,
  assertDraft,
  offsetsExactly,
  parseJournalEntryId,
  planReversal,
  reversalLines,
} from "./index";

const cash = account("asset");
const card = account("liability");
const food = account("expense");
const accounts = lookup(cash, card, food);
const lines = [jl(food, "debit", "640", "weekly shop"), jl(card, "credit", "600"), jl(cash, "credit", "40")];
const otherId = parseJournalEntryId("00000000-0000-4000-8000-0000000000aa");

const entry = (overrides: Partial<Parameters<typeof planReversal>[0]> = {}) => ({
  status: "posted" as const,
  lines,
  reversesEntryId: null,
  reversedByEntryId: null,
  ...overrides,
});

describe("posting transition", () => {
  it("allows a balanced draft to post", () => {
    expect(() => assertCanPost({ status: "draft", lines }, accounts)).not.toThrow();
  });

  it("refuses posted entries (posted is terminal)", () => {
    expect(() => assertDraft({ status: "posted" })).toThrow(EntryNotDraftError);
    expect(() => assertCanPost({ status: "posted", lines }, accounts)).toThrow(EntryNotDraftError);
  });

  it("refuses an invalid draft with its issues", () => {
    expect(() => assertCanPost({ status: "draft", lines: lines.slice(1) }, accounts)).toThrow(LedgerValidationError);
  });
});

describe("reversal construction", () => {
  it("swaps every side and keeps accounts, amounts and memos", () => {
    const reversed = reversalLines({ lines });
    expect(reversed.map((l) => [l.accountId, l.side, l.amount.minor, l.memo])).toEqual([
      [food.id, "credit", 64000n, "weekly shop"],
      [card.id, "debit", 60000n, null],
      [cash.id, "debit", 4000n, null],
    ]);
    expect(offsetsExactly(lines, reversed)).toBe(true);
    expect(() => assertCanPost({ status: "draft", lines: reversed }, accounts)).not.toThrow();
  });

  it("does not mutate the original lines", () => {
    reversalLines({ lines });
    expect(lines[0]!.side).toBe("debit");
  });

  it("plans a reversal only for posted, non-reversal, not-yet-reversed entries", () => {
    expect(planReversal(entry())).toHaveLength(3);
    expect(() => planReversal(entry({ status: "draft" }))).toThrow(EntryNotReversibleError);
    expect(() => planReversal(entry({ reversesEntryId: otherId }))).toThrow(
      expect.objectContaining({ reason: "is-reversal" }),
    );
    expect(() => planReversal(entry({ reversedByEntryId: otherId }))).toThrow(EntryAlreadyReversedError);
  });

  it("detects lines that do not exactly offset", () => {
    expect(offsetsExactly(lines, lines)).toBe(false);
    expect(offsetsExactly(lines, reversalLines({ lines }).slice(1))).toBe(false);
    expect(offsetsExactly(lines, [...reversalLines({ lines }), jl(cash, "debit", "1")])).toBe(false);
    expect(offsetsExactly([], [])).toBe(true);
  });

  it("uses a shared error base and readable messages", () => {
    for (const error of [
      new EntryNotDraftError(),
      new EntryAlreadyReversedError(),
      new EntryNotReversibleError("not-posted"),
      new EntryNotReversibleError("is-reversal"),
    ]) {
      expect(error).toBeInstanceOf(LedgerError);
      expect(error.name).toBe(error.constructor.name);
      expect(error.message.length).toBeGreaterThan(10);
    }
  });
});
