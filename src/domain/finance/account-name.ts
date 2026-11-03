// Account-name canonicalisation (ADR 0007). Deliberately import-free: the

declare const canonical: unique symbol;

export interface AccountName {
  readonly display: string;
  readonly key: string;
  readonly [canonical]: true;
}

/**
 * 1. `trim()`: ECMAScript WhiteSpace and LineTerminator at either end.
 * 2. NFC (canonical composition; never NFKC).
 * 3. Key: `toLowerCase()`, i.e. Unicode Default Case Conversion with full
 *    mappings, Final_Sigma and no locale tailoring, then NFC again.
 *
 * Lower-casing is not case folding: sharp s (U+00DF) and "ss" stay different.
 * The Unicode tables come from the runtime's ICU: hence the pinned Node version.
 */
export function canonicalAccountName(input: string): AccountName {
  const display = input.trim().normalize("NFC");
  return Object.freeze({
    display,
    key: display.toLowerCase().normalize("NFC"),
  }) as AccountName;
}
