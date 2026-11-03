import {
  EntryAlreadyReversedError,
  EntryNotDraftError,
  EntryNotReversibleError,
} from "./errors";
import type { JournalEntry, JournalLine, Side } from "./types";
import { type AccountLookup, assertPostable } from "./validation";

export function assertDraft(entry: Pick<JournalEntry, "status">): void {
  if (entry.status !== "draft") throw new EntryNotDraftError();
}

export function assertCanPost(
  entry: Pick<JournalEntry, "status" | "lines">,
  accounts: AccountLookup,
): void {
  assertDraft(entry);
  assertPostable(entry.lines, accounts);
}

const OPPOSITE: Record<Side, Side> = { debit: "credit", credit: "debit" };

export function reversalLines(
  original: Pick<JournalEntry, "lines">,
): JournalLine[] {
  return original.lines.map((line) =>
    Object.freeze({ ...line, side: OPPOSITE[line.side] }),
  );
}

export function planReversal(
  original: Pick<
    JournalEntry,
    "status" | "lines" | "reversesEntryId" | "reversedByEntryId"
  >,
): JournalLine[] {
  if (original.status !== "posted")
    throw new EntryNotReversibleError("not-posted");
  if (original.reversesEntryId !== null)
    throw new EntryNotReversibleError("is-reversal");
  if (original.reversedByEntryId !== null)
    throw new EntryAlreadyReversedError();
  return reversalLines(original);
}

export function offsetsExactly(
  original: readonly JournalLine[],
  reversal: readonly JournalLine[],
): boolean {
  const net = new Map<string, bigint>();
  const add = (lines: readonly JournalLine[]) => {
    for (const l of lines) {
      const key = `${l.accountId}/${l.amount.currency.code}`;
      const signed = l.side === "debit" ? l.amount.minor : -l.amount.minor;
      net.set(key, (net.get(key) ?? 0n) + signed);
    }
  };
  add(original);
  add(reversal);
  return [...net.values()].every((v) => v === 0n);
}
