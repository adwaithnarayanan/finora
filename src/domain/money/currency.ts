import { InvalidCurrencyError } from "./errors";

/**
 * A currency as the money module understands it: an ISO 4217 alphabetic code
 * plus the number of minor-unit digits (INR 2 → paise, JPY 0, KWD 3).
 */
export interface Currency {
  readonly code: string;
  readonly exponent: number;
}

const CODE_PATTERN = /^[A-Z]{3}$/;

/** ISO 4217 allows at most 4 minor-unit digits; 6 leaves headroom without inviting abuse. */
export const MAX_CURRENCY_EXPONENT = 6;

/**
 * Defines a currency explicitly. Use this for codes not in {@link KNOWN_CURRENCIES};
 * the caller is responsible for the exponent being correct.
 */
export function defineCurrency(code: string, exponent: number): Currency {
  if (typeof code !== "string" || !CODE_PATTERN.test(code)) {
    throw new InvalidCurrencyError(
      `Currency code must be three uppercase letters, got ${JSON.stringify(code)}`,
    );
  }
  if (
    !Number.isInteger(exponent) ||
    exponent < 0 ||
    exponent > MAX_CURRENCY_EXPONENT
  ) {
    throw new InvalidCurrencyError(
      `Minor-unit exponent for ${code} must be an integer from 0 to ${MAX_CURRENCY_EXPONENT}, got ${String(exponent)}`,
    );
  }
  return Object.freeze({ code, exponent });
}

/** Currencies with known ISO 4217 minor units. INR is Finora's operating currency. */
export const KNOWN_CURRENCIES = Object.freeze({
  INR: defineCurrency("INR", 2),
  USD: defineCurrency("USD", 2),
  EUR: defineCurrency("EUR", 2),
  GBP: defineCurrency("GBP", 2),
  JPY: defineCurrency("JPY", 0),
  KWD: defineCurrency("KWD", 3),
});

export type KnownCurrencyCode = keyof typeof KNOWN_CURRENCIES;

export const INR = KNOWN_CURRENCIES.INR;

/** Looks up a known currency by code; throws for unknown codes rather than guessing an exponent. */
export function currency(code: string): Currency {
  if (Object.hasOwn(KNOWN_CURRENCIES, code)) {
    return KNOWN_CURRENCIES[code as KnownCurrencyCode];
  }
  throw new InvalidCurrencyError(
    `Unknown currency ${JSON.stringify(code)}; use defineCurrency() with an explicit exponent`,
  );
}

export function sameCurrency(a: Currency, b: Currency): boolean {
  return a.code === b.code && a.exponent === b.exponent;
}
