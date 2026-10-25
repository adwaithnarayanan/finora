import { isCanonicalUuid } from "@/domain/shared/uuid";

import { InvalidLedgerInputError } from "./errors";

declare const accountIdBrand: unique symbol;
declare const entryIdBrand: unique symbol;

export type LedgerAccountId = string & { readonly [accountIdBrand]: true };
export type JournalEntryId = string & { readonly [entryIdBrand]: true };

export function isLedgerAccountId(value: unknown): value is LedgerAccountId {
  return isCanonicalUuid(value);
}

export function parseLedgerAccountId(value: unknown): LedgerAccountId {
  if (!isLedgerAccountId(value)) {
    throw new InvalidLedgerInputError("Ledger account id must be a canonical lowercase UUID");
  }
  return value;
}

export function parseJournalEntryId(value: unknown): JournalEntryId {
  if (!isCanonicalUuid(value)) {
    throw new InvalidLedgerInputError("Journal entry id must be a canonical lowercase UUID");
  }
  return value as JournalEntryId;
}
