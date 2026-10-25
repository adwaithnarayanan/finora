import { InvalidLedgerInputError } from "./errors";

declare const ledgerDateBrand: unique symbol;

/** A calendar date as `YYYY-MM-DD` (no time zone): the entry's accounting date. */
export type LedgerDate = string & { readonly [ledgerDateBrand]: true };

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseLedgerDate(value: unknown): LedgerDate {
  const match = typeof value === "string" ? DATE_PATTERN.exec(value) : null;
  if (match) {
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      year >= 1000 &&
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    ) {
      return value as LedgerDate;
    }
  }
  throw new InvalidLedgerInputError("Entry date must be a valid calendar date in YYYY-MM-DD form");
}

export const MAX_DESCRIPTION_LENGTH = 500;
export const MAX_MEMO_LENGTH = 500;
export const MAX_ACCOUNT_NAME_LENGTH = 100;

function boundedText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") {
    throw new InvalidLedgerInputError(`${label} must be a string`);
  }
  const text = value.trim();
  if (text.length === 0 || text.length > max) {
    throw new InvalidLedgerInputError(`${label} must be 1 to ${max} characters`);
  }
  return text;
}

export function parseDescription(value: unknown): string {
  return boundedText(value, "Description", MAX_DESCRIPTION_LENGTH);
}

export function parseAccountName(value: unknown): string {
  return boundedText(value, "Account name", MAX_ACCOUNT_NAME_LENGTH);
}

/** Optional memo: absent, null or blank become null. */
export function parseMemo(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  return boundedText(value, "Memo", MAX_MEMO_LENGTH);
}
