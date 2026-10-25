import { InvalidIdempotencyKeyError } from "./errors";
import type { LedgerDate } from "./fields";
import type { JournalEntryId } from "./ids";
import type { JournalLine } from "./types";

declare const idempotencyKeyBrand: unique symbol;

/** A client-chosen retry key; unique per owner (enforced by the database). */
export type IdempotencyKey = string & { readonly [idempotencyKeyBrand]: true };

/** Same rule as the `journal_entries_idempotency_key_format` CHECK. */
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function parseIdempotencyKey(value: unknown): IdempotencyKey {
  if (typeof value !== "string" || !KEY_PATTERN.test(value)) {
    throw new InvalidIdempotencyKeyError(
      "Idempotency key must be 1-128 characters: letters, digits, '.', '_', ':' or '-', starting with a letter or digit",
    );
  }
  return value as IdempotencyKey;
}

interface EntryContent {
  readonly entryDate: LedgerDate;
  readonly description: string;
  readonly lines: readonly JournalLine[];
}

/**
 * The operations a key can protect. A key replays only the operation it was
 * first used for, with the same content; anything else is a conflict.
 */
export type IdempotentRequest =
  | ({ readonly kind: "create-draft" } & EntryContent)
  | ({ readonly kind: "post-entry" } & EntryContent)
  | {
      readonly kind: "reverse-entry";
      readonly entryId: JournalEntryId;
      readonly entryDate: LedgerDate;
      readonly description: string;
    }
  | {
      readonly kind: "correct-entry";
      readonly entryId: JournalEntryId;
      readonly entryDate: LedgerDate;
      readonly description: string;
      readonly replacement: EntryContent;
    };

function canonicalLines(lines: readonly JournalLine[]) {
  return lines.map((l) => [
    l.accountId,
    l.side,
    l.amount.currency.code,
    l.amount.currency.exponent,
    l.amount.minor.toString(),
    l.memo,
  ]);
}

function canonicalContent(content: EntryContent) {
  return [content.entryDate, content.description, canonicalLines(content.lines)];
}

/**
 * A deterministic text form of a request, used to fingerprint it. Amounts are
 * exact minor units, so "1.5" and "1.50" are the same request; line order is
 * significant.
 */
export function canonicalRequest(request: IdempotentRequest): string {
  switch (request.kind) {
    case "create-draft":
    case "post-entry":
      return JSON.stringify(["v1", request.kind, ...canonicalContent(request)]);
    case "reverse-entry":
      return JSON.stringify(["v1", request.kind, request.entryId, request.entryDate, request.description]);
    case "correct-entry":
      return JSON.stringify([
        "v1",
        request.kind,
        request.entryId,
        request.entryDate,
        request.description,
        canonicalContent(request.replacement),
      ]);
  }
}
