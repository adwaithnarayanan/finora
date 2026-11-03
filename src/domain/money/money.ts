import { type Currency, sameCurrency } from "./currency";
import {
  CurrencyMismatchError,
  InvalidAllocationError,
  InvalidAmountError,
  PrecisionError,
} from "./errors";
import { type RoundingMode, divideAndRound, pow10 } from "./rounding";

const DECIMAL_PATTERN = /^(-?)(\d+)(?:\.(\d+))?$/;

export const MAX_DECIMAL_INPUT_LENGTH = 64;

export const MAX_ALLOCATION_PARTS = 10_000;

export interface ParseOptions {
  readonly rounding?: RoundingMode;
}

export interface FormatOptions {
  readonly locale?: string;
  readonly currencyDisplay?: "symbol" | "narrowSymbol" | "code" | "name";
}

export class Money {
  readonly minor: bigint;
  readonly currency: Currency;

  private constructor(minor: bigint, currency: Currency) {
    this.minor = minor;
    this.currency = currency;
    Object.freeze(this);
  }

  static ofMinor(minor: bigint, currency: Currency): Money {
    if (typeof minor !== "bigint") {
      throw new InvalidAmountError(
        `Minor units must be a bigint, got ${typeof minor}`,
      );
    }
    return new Money(minor, currency);
  }

  static zero(currency: Currency): Money {
    return new Money(0n, currency);
  }

  static parse(
    input: string,
    currency: Currency,
    options: ParseOptions = {},
  ): Money {
    if (typeof input !== "string") {
      throw new InvalidAmountError(
        `Amount must be a decimal string, got ${typeof input}`,
      );
    }
    if (input.length > MAX_DECIMAL_INPUT_LENGTH) {
      throw new InvalidAmountError(
        `Amount string exceeds ${MAX_DECIMAL_INPUT_LENGTH} characters`,
      );
    }
    const match = DECIMAL_PATTERN.exec(input);
    if (!match) {
      throw new InvalidAmountError(
        `Not a plain decimal amount: ${JSON.stringify(input)}`,
      );
    }
    const [, sign = "", whole = "", fraction = ""] = match;
    const { exponent } = currency;

    if (fraction.length <= exponent) {
      const minor = BigInt(whole + fraction.padEnd(exponent, "0"));
      return new Money(sign ? -minor : minor, currency);
    }

    const excessDigits = fraction.length - exponent;
    const scaled = BigInt(whole + fraction);
    const signed = sign ? -scaled : scaled;
    const divisor = pow10(excessDigits);

    if (signed % divisor === 0n) {
      return new Money(signed / divisor, currency);
    }
    if (options.rounding === undefined) {
      throw new PrecisionError(
        `${JSON.stringify(input)} has more than ${exponent} fractional digit(s) for ${currency.code}; pass a rounding mode to round explicitly`,
      );
    }
    return new Money(
      divideAndRound(signed, divisor, options.rounding),
      currency,
    );
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor - other.minor, this.currency);
  }

  negate(): Money {
    return new Money(-this.minor, this.currency);
  }

  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    if (this.minor < other.minor) return -1;
    if (this.minor > other.minor) return 1;
    return 0;
  }

  equals(other: Money): boolean {
    return this.compare(other) === 0;
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  /**
   * Splits this amount by non-negative integer ratios without losing a minor unit.
   * Each share is truncated toward zero; the leftover units go one at a time to the
   * shares with the largest truncated remainder, ties broken by lower index.
   * Zero-ratio recipients always receive zero.
   */
  allocate(ratios: readonly bigint[]): Money[] {
    if (ratios.length === 0) {
      throw new InvalidAllocationError("At least one ratio is required");
    }
    let total = 0n;
    for (const ratio of ratios) {
      if (typeof ratio !== "bigint" || ratio < 0n) {
        throw new InvalidAllocationError(
          "Ratios must be non-negative bigint values",
        );
      }
      total += ratio;
    }
    if (total === 0n) {
      throw new InvalidAllocationError("Ratios must not all be zero");
    }

    const shares: bigint[] = [];
    const remainders: bigint[] = [];
    let distributed = 0n;
    for (const ratio of ratios) {
      const product = this.minor * ratio;
      const share = product / total;
      const remainder = product % total;
      shares.push(share);
      remainders.push(remainder < 0n ? -remainder : remainder);
      distributed += share;
    }

    let leftover = this.minor - distributed;
    const unit = leftover < 0n ? -1n : 1n;
    const order = remainders
      .map((remainder, index) => ({ remainder, index }))
      .filter(({ remainder }) => remainder > 0n)
      .sort((a, b) =>
        a.remainder === b.remainder
          ? a.index - b.index
          : a.remainder > b.remainder
            ? -1
            : 1,
      );
    for (const { index } of order) {
      if (leftover === 0n) break;
      shares[index] = (shares[index] ?? 0n) + unit;
      leftover -= unit;
    }

    return shares.map((share) => new Money(share, this.currency));
  }

  allocateEvenly(parts: number): Money[] {
    if (
      !Number.isSafeInteger(parts) ||
      parts < 1 ||
      parts > MAX_ALLOCATION_PARTS
    ) {
      throw new InvalidAllocationError(
        `Part count must be an integer from 1 to ${MAX_ALLOCATION_PARTS}`,
      );
    }
    return this.allocate(Array.from({ length: parts }, () => 1n));
  }

  toDecimalString(): string {
    const { exponent } = this.currency;
    const negative = this.minor < 0n;
    const digits = (negative ? -this.minor : this.minor)
      .toString()
      .padStart(exponent + 1, "0");
    const sign = negative ? "-" : "";
    if (exponent === 0) return sign + digits;
    return `${sign}${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
  }

  format(options: FormatOptions = {}): string {
    const formatter = new Intl.NumberFormat(options.locale ?? "en-IN", {
      style: "currency",
      currency: this.currency.code,
      currencyDisplay: options.currencyDisplay ?? "symbol",
      minimumFractionDigits: this.currency.exponent,
      maximumFractionDigits: this.currency.exponent,
    });
    return formatter.format(
      this.toDecimalString() as Intl.StringNumericLiteral,
    );
  }

  toString(): string {
    return `${this.currency.code} ${this.toDecimalString()}`;
  }

  private assertSameCurrency(other: Money): void {
    if (!sameCurrency(this.currency, other.currency)) {
      throw new CurrencyMismatchError(
        `Cannot combine ${this.currency.code} (exponent ${this.currency.exponent}) with ${other.currency.code} (exponent ${other.currency.exponent})`,
      );
    }
  }
}
