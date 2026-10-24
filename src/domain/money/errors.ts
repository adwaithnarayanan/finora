/** Base class for every error raised by the money module. */
export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A currency code or minor-unit exponent is not valid. */
export class InvalidCurrencyError extends MoneyError {}

/** A value is not an acceptable monetary amount (bad syntax, wrong type, unsafe size). */
export class InvalidAmountError extends MoneyError {}

/** An amount has more fractional digits than the currency allows and no rounding mode was given. */
export class PrecisionError extends MoneyError {}

/** Two amounts in different currencies were combined. */
export class CurrencyMismatchError extends MoneyError {}

/** Allocation ratios or part counts are not usable. */
export class InvalidAllocationError extends MoneyError {}
