import { describe, expect, it } from "vitest";

import { divideAndRound, pow10 } from "./rounding";

describe("divideAndRound", () => {
  it("returns exact quotients unchanged in every mode", () => {
    expect(divideAndRound(1000n, 10n, "half-even")).toBe(100n);
    expect(divideAndRound(-1000n, 10n, "ceiling")).toBe(-100n);
    expect(divideAndRound(0n, 7n, "floor")).toBe(0n);
  });

  it("rejects a non-positive divisor", () => {
    expect(() => divideAndRound(1n, 0n, "floor")).toThrow(RangeError);
    expect(() => divideAndRound(1n, -10n, "floor")).toThrow(RangeError);
  });

  it("rounds half-even on ties in both directions", () => {
    expect(divideAndRound(25n, 10n, "half-even")).toBe(2n);
    expect(divideAndRound(35n, 10n, "half-even")).toBe(4n);
    expect(divideAndRound(-25n, 10n, "half-even")).toBe(-2n);
    expect(divideAndRound(-35n, 10n, "half-even")).toBe(-4n);
  });

  it("handles odd divisors, which never tie", () => {
    expect(divideAndRound(5n, 3n, "half-even")).toBe(2n);
    expect(divideAndRound(4n, 3n, "half-away-from-zero")).toBe(1n);
  });
});

describe("pow10", () => {
  it("computes exact powers of ten", () => {
    expect(pow10(0)).toBe(1n);
    expect(pow10(2)).toBe(100n);
    expect(pow10(30)).toBe(1_000_000_000_000_000_000_000_000_000_000n);
  });
});
