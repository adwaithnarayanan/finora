# ADR 0002: Money representation

- Status: Accepted
- Date: 2026-10-25

## Context

JavaScript `number` is IEEE-754 binary floating point: `0.1 + 0.2 !== 0.3` and
integers above 2^53 lose precision. Financial amounts must be exact. Finora operates
in INR but must not be redesigned to hold other currencies later.

## Decision

- An amount is an immutable `Money` value (`src/domain/money`) holding:
  - `minor: bigint`: an integer count of minor units (paise for INR);
  - `currency: { code, exponent }`: ISO 4217 code plus minor-unit digits
    (INR 2, JPY 0, KWD 3). Unknown codes are never guessed; they must be defined
    explicitly with `defineCurrency`.
- No public API accepts a JavaScript `number` as an amount. Amounts enter via
  `Money.parse(decimalString, currency)` or `Money.ofMinor(bigint, currency)`;
  both reject other types at runtime.
- Parsing accepts only plain decimals (`-?\d+(\.\d+)?`, max 64 characters): no `+`,
  exponents, grouping separators or whitespace.
- Excess precision is rejected with `PrecisionError` unless the caller passes an
  explicit rounding mode (`half-even`, `half-away-from-zero`, `toward-zero`,
  `floor`, `ceiling`). Trailing zeros (`"1.500"` for INR) are exact and accepted.
- Arithmetic and comparison require the same code **and** exponent, otherwise
  `CurrencyMismatchError`. There is no FX conversion.
- Allocation splits by non-negative `bigint` ratios with no loss: shares truncate
  toward zero, and leftover units go to the largest remainders, ties to the lower
  index. 100 paise across three gives 34/33/33; negative amounts mirror this.
- `toDecimalString()` is the canonical exact representation (storage, CSV, APIs).
  `format()` passes that string to `Intl.NumberFormat` (string input is exact),
  defaulting to `en-IN` grouping.
- `Money` deliberately fails `JSON.stringify` (bigint), so it cannot be serialised
  silently; serialisation must go through `toDecimalString()`.

## Consequences

- Persistence (Milestone 2+) will store minor units as PostgreSQL `BIGINT` with a
  currency code column; the persistence layer must reject values outside the BIGINT
  range, which the domain type itself does not bound.
- Non-monetary decimals (investment quantities, interest rates) need a separate
  exact type when those features arrive; they are not `Money`.
