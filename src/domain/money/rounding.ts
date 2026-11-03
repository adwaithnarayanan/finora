export const ROUNDING_MODES = [
  "half-even",
  "half-away-from-zero",
  "toward-zero",
  "floor",
  "ceiling",
] as const;

export type RoundingMode = (typeof ROUNDING_MODES)[number];

export function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

export function divideAndRound(
  value: bigint,
  divisor: bigint,
  mode: RoundingMode,
): bigint {
  if (divisor <= 0n) {
    throw new RangeError("Divisor must be positive");
  }
  const quotient = value / divisor;
  const remainder = value % divisor;
  if (remainder === 0n) return quotient;

  const awayFromZero = value < 0n ? quotient - 1n : quotient + 1n;
  switch (mode) {
    case "toward-zero":
      return quotient;
    case "floor":
      return value < 0n ? quotient - 1n : quotient;
    case "ceiling":
      return value > 0n ? quotient + 1n : quotient;
    case "half-away-from-zero":
    case "half-even": {
      const twiceRemainder = 2n * (remainder < 0n ? -remainder : remainder);
      if (twiceRemainder > divisor) return awayFromZero;
      if (twiceRemainder < divisor) return quotient;
      if (mode === "half-away-from-zero") return awayFromZero;
      return quotient % 2n === 0n ? quotient : awayFromZero;
    }
    default: {
      const unknown: never = mode;
      throw new RangeError(`Unknown rounding mode: ${String(unknown)}`);
    }
  }
}
