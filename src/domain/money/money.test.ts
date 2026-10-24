import { describe, expect, it } from "vitest";

import {
  CurrencyMismatchError,
  INR,
  InvalidAllocationError,
  InvalidAmountError,
  KNOWN_CURRENCIES,
  MAX_ALLOCATION_PARTS,
  MAX_DECIMAL_INPUT_LENGTH,
  Money,
  MoneyError,
  PrecisionError,
  ROUNDING_MODES,
  type RoundingMode,
  defineCurrency,
} from "./index";

const { USD, JPY, KWD } = KNOWN_CURRENCIES;
const inr = (value: string) => Money.parse(value, INR);
const minors = (values: Money[]) => values.map((m) => m.minor);

describe("Money.ofMinor / zero", () => {
  it("holds an exact bigint amount and its currency", () => {
    const m = Money.ofMinor(12345n, INR);
    expect(m.minor).toBe(12345n);
    expect(m.currency).toBe(INR);
  });

  it("creates zero", () => {
    expect(Money.zero(INR).minor).toBe(0n);
    expect(Money.zero(INR).isZero()).toBe(true);
  });

  it("rejects JavaScript numbers at runtime", () => {
    expect(() => Money.ofMinor(100 as unknown as bigint, INR)).toThrow(
      InvalidAmountError,
    );
    expect(() => Money.ofMinor(0.1 as unknown as bigint, INR)).toThrow(
      InvalidAmountError,
    );
  });

  it("is immutable", () => {
    const m = Money.ofMinor(1n, INR);
    expect(Object.isFrozen(m)).toBe(true);
    expect(() => {
      (m as { minor: bigint }).minor = 2n;
    }).toThrow(TypeError);
  });

  it("refuses silent JSON serialisation (bigint is not JSON)", () => {
    expect(() => JSON.stringify(Money.ofMinor(1n, INR))).toThrow(TypeError);
  });
});

describe("Money.parse", () => {
  it.each([
    ["0", 0n],
    ["0.00", 0n],
    ["1", 100n],
    ["1.5", 150n],
    ["1.50", 150n],
    ["1234.56", 123456n],
    ["0.01", 1n],
    ["007.10", 710n],
    ["-0.01", -1n],
    ["-1234.56", -123456n],
    ["-0", 0n],
    ["-0.00", 0n],
  ])("parses %s INR to %s paise", (input, expected) => {
    expect(inr(input).minor).toBe(expected);
  });

  it("never produces a negative zero", () => {
    expect(Object.is(Number(inr("-0").minor), -0)).toBe(false);
    expect(inr("-0").isNegative()).toBe(false);
  });

  it("is exact where floating point is not", () => {
    // 0.1 + 0.2 !== 0.3 in IEEE-754; it must be exact here.
    expect(inr("0.1").add(inr("0.2")).equals(inr("0.3"))).toBe(true);
  });

  it("handles values far beyond Number.MAX_SAFE_INTEGER exactly", () => {
    const big = "90071992547409931234567.89";
    expect(inr(big).minor).toBe(9007199254740993123456789n);
    expect(inr(big).toDecimalString()).toBe(big);
    expect(inr(`-${big}`).toDecimalString()).toBe(`-${big}`);
  });

  it("respects each currency's exponent", () => {
    expect(Money.parse("1500", JPY).minor).toBe(1500n);
    expect(Money.parse("1.234", KWD).minor).toBe(1234n);
    expect(Money.parse("1.2", KWD).minor).toBe(1200n);
    expect(() => Money.parse("1.5", JPY)).toThrow(PrecisionError);
  });

  it("accepts trailing zeros beyond the exponent because the value is exact", () => {
    expect(inr("1.500").minor).toBe(150n);
    expect(inr("-2.0000").minor).toBe(-200n);
    expect(Money.parse("7.000", JPY).minor).toBe(7n);
  });

  it("rejects excess precision unless a rounding mode is given", () => {
    expect(() => inr("1.005")).toThrow(PrecisionError);
    expect(() => inr("-0.001")).toThrow(PrecisionError);
    expect(() => inr("1.0001")).toThrow(/rounding mode/);
  });

  it.each([
    "",
    " ",
    " 1.00",
    "1.00 ",
    "+1.00",
    "1,000.00",
    "1_000",
    ".5",
    "5.",
    "1.2.3",
    "1e3",
    "1E-2",
    "--1",
    "- 1",
    "0x10",
    "Infinity",
    "NaN",
    "abc",
    "١٢٣", // non-ASCII digits
    "1.5\n",
  ])("rejects malformed input %j", (input) => {
    expect(() => inr(input)).toThrow(InvalidAmountError);
  });

  it("rejects non-string input such as numbers", () => {
    expect(() => Money.parse(1.5 as unknown as string, INR)).toThrow(
      InvalidAmountError,
    );
    expect(() => Money.parse(10n as unknown as string, INR)).toThrow(
      InvalidAmountError,
    );
    expect(() => Money.parse(null as unknown as string, INR)).toThrow(
      InvalidAmountError,
    );
  });

  it("enforces the maximum input length", () => {
    const atLimit = "9".repeat(MAX_DECIMAL_INPUT_LENGTH);
    expect(inr(atLimit).minor).toBe(BigInt(atLimit) * 100n);
    expect(() => inr("9".repeat(MAX_DECIMAL_INPUT_LENGTH + 1))).toThrow(
      InvalidAmountError,
    );
  });

  it("all errors share the MoneyError base class", () => {
    expect(() => inr("x")).toThrow(MoneyError);
    expect(() => inr("1.001")).toThrow(MoneyError);
  });
});

describe("Money.parse with explicit rounding", () => {
  // Cases: [input, expected paise per mode in ROUNDING_MODES order]
  // order: half-even, half-away-from-zero, toward-zero, floor, ceiling
  const table: Array<[string, [bigint, bigint, bigint, bigint, bigint]]> = [
    ["1.005", [100n, 101n, 100n, 100n, 101n]], // tie, even below
    ["1.015", [102n, 102n, 101n, 101n, 102n]], // tie, even above
    ["1.004", [100n, 100n, 100n, 100n, 101n]],
    ["1.006", [101n, 101n, 100n, 100n, 101n]],
    ["-1.005", [-100n, -101n, -100n, -101n, -100n]],
    ["-1.015", [-102n, -102n, -101n, -102n, -101n]],
    ["-1.004", [-100n, -100n, -100n, -101n, -100n]],
    ["-1.006", [-101n, -101n, -100n, -101n, -100n]],
    ["0.0050", [0n, 1n, 0n, 0n, 1n]],
    ["-0.0050", [0n, -1n, 0n, -1n, 0n]],
    ["0.00500001", [1n, 1n, 0n, 0n, 1n]], // just over the tie
    ["0.00499999", [0n, 0n, 0n, 0n, 1n]], // just under the tie
  ];

  for (const [input, expected] of table) {
    ROUNDING_MODES.forEach((mode, i) => {
      it(`${input} with ${mode} → ${expected[i]}`, () => {
        expect(Money.parse(input, INR, { rounding: mode }).minor).toBe(
          expected[i],
        );
      });
    });
  }

  it("does not round exact input even when a mode is given", () => {
    expect(Money.parse("1.25", INR, { rounding: "floor" }).minor).toBe(125n);
    expect(Money.parse("1.2500", INR, { rounding: "ceiling" }).minor).toBe(
      125n,
    );
  });

  it("never yields negative zero after rounding", () => {
    const m = Money.parse("-0.001", INR, { rounding: "half-even" });
    expect(m.minor).toBe(0n);
    expect(m.toDecimalString()).toBe("0.00");
  });

  it("rejects an unknown rounding mode", () => {
    expect(() =>
      Money.parse("1.005", INR, { rounding: "bankers" as RoundingMode }),
    ).toThrow(RangeError);
  });
});

describe("arithmetic", () => {
  it("adds and subtracts exactly", () => {
    expect(inr("10.10").add(inr("0.90")).toDecimalString()).toBe("11.00");
    expect(inr("10.00").subtract(inr("10.01")).toDecimalString()).toBe(
      "-0.01",
    );
    expect(inr("-5").add(inr("5")).isZero()).toBe(true);
  });

  it("negates", () => {
    expect(inr("12.34").negate().minor).toBe(-1234n);
    expect(inr("-12.34").negate().minor).toBe(1234n);
    expect(Money.zero(INR).negate().minor).toBe(0n);
  });

  it("does not mutate operands", () => {
    const a = inr("1.00");
    const b = inr("2.00");
    a.add(b);
    a.subtract(b);
    a.negate();
    expect(a.minor).toBe(100n);
    expect(b.minor).toBe(200n);
  });

  it("stays exact well past 2^53", () => {
    const max = Money.ofMinor(BigInt(Number.MAX_SAFE_INTEGER), INR);
    const sum = max.add(Money.ofMinor(2n, INR));
    expect(sum.minor).toBe(9007199254740993n);
  });

  it("reports sign", () => {
    expect(inr("0.01").isPositive()).toBe(true);
    expect(inr("0.01").isNegative()).toBe(false);
    expect(inr("-0.01").isNegative()).toBe(true);
    expect(inr("-0.01").isPositive()).toBe(false);
    expect(Money.zero(INR).isPositive()).toBe(false);
    expect(Money.zero(INR).isNegative()).toBe(false);
  });
});

describe("comparison", () => {
  it("compares", () => {
    expect(inr("1.00").compare(inr("2.00"))).toBe(-1);
    expect(inr("2.00").compare(inr("1.00"))).toBe(1);
    expect(inr("1.00").compare(inr("1"))).toBe(0);
    expect(inr("-1.00").compare(inr("0"))).toBe(-1);
  });

  it("checks equality by value and currency", () => {
    expect(inr("1.50").equals(inr("1.5"))).toBe(true);
    expect(inr("1.50").equals(inr("1.51"))).toBe(false);
  });
});

describe("currency mismatch", () => {
  const usd = Money.parse("1.00", USD);

  it.each([
    ["add", () => inr("1.00").add(usd)],
    ["subtract", () => inr("1.00").subtract(usd)],
    ["compare", () => inr("1.00").compare(usd)],
    ["equals", () => inr("1.00").equals(usd)],
  ])("%s rejects mixed currencies", (_name, op) => {
    expect(op).toThrow(CurrencyMismatchError);
  });

  it("treats the same code with a different exponent as a mismatch", () => {
    const oddInr = defineCurrency("INR", 3);
    expect(() => inr("1.00").add(Money.parse("1.000", oddInr))).toThrow(
      CurrencyMismatchError,
    );
  });

  it("accepts structurally equal currency definitions", () => {
    const otherInr = defineCurrency("INR", 2);
    expect(inr("1.00").add(Money.parse("1.00", otherInr)).minor).toBe(200n);
  });
});

describe("allocation", () => {
  it("splits 100 minor units three ways without loss (34/33/33)", () => {
    expect(minors(Money.ofMinor(100n, INR).allocateEvenly(3))).toEqual([
      34n,
      33n,
      33n,
    ]);
  });

  it("is deterministic and always sums to the original", () => {
    const cases: Array<[bigint, bigint[]]> = [
      [100n, [1n, 1n, 1n]],
      [-100n, [1n, 1n, 1n]],
      [5n, [3n, 7n]],
      [1n, [1n, 1n, 1n, 1n]],
      [0n, [1n, 2n]],
      [99999n, [7n, 13n, 0n, 80n]],
      [123456789012345678901234567890n, [1n, 1n, 1n, 1n, 1n, 1n, 1n]],
    ];
    for (const [amount, ratios] of cases) {
      const money = Money.ofMinor(amount, INR);
      const first = minors(money.allocate(ratios));
      const second = minors(money.allocate(ratios));
      expect(first).toEqual(second);
      expect(first.reduce((a, b) => a + b, 0n)).toBe(amount);
    }
  });

  it("allocates by ratio, giving leftovers to the largest remainders", () => {
    // 5 * 3/10 = 1.5, 5 * 7/10 = 3.5 → tie, lower index wins → [2, 3]
    expect(minors(Money.ofMinor(5n, INR).allocate([3n, 7n]))).toEqual([
      2n,
      3n,
    ]);
    // 10 * 1/6 = 1.67, 10 * 5/6 = 8.33 → leftover to index 0 → [2, 8]
    expect(minors(Money.ofMinor(10n, INR).allocate([1n, 5n]))).toEqual([
      2n,
      8n,
    ]);
    // 100 at 70/20/10 divides exactly
    expect(
      minors(Money.ofMinor(100n, INR).allocate([70n, 20n, 10n])),
    ).toEqual([70n, 20n, 10n]);
  });

  it("mirrors positive allocation for negative amounts", () => {
    expect(minors(Money.ofMinor(-100n, INR).allocateEvenly(3))).toEqual([
      -34n,
      -33n,
      -33n,
    ]);
    expect(minors(Money.ofMinor(-5n, INR).allocate([3n, 7n]))).toEqual([
      -2n,
      -3n,
    ]);
  });

  it("gives zero to zero-ratio recipients", () => {
    expect(minors(Money.ofMinor(10n, INR).allocate([0n, 1n, 0n, 2n]))).toEqual(
      [0n, 3n, 0n, 7n],
    );
    expect(minors(Money.ofMinor(7n, INR).allocate([0n, 1n]))).toEqual([
      0n,
      7n,
    ]);
  });

  it("handles fewer units than recipients", () => {
    expect(minors(Money.ofMinor(2n, INR).allocateEvenly(5))).toEqual([
      1n,
      1n,
      0n,
      0n,
      0n,
    ]);
  });

  it("keeps the currency on every share", () => {
    for (const share of Money.parse("10", KWD).allocateEvenly(3)) {
      expect(share.currency).toBe(KWD);
    }
  });

  it("allows a single recipient", () => {
    expect(minors(inr("12.34").allocateEvenly(1))).toEqual([1234n]);
  });

  it.each([
    ["empty ratios", () => inr("1").allocate([])],
    ["all-zero ratios", () => inr("1").allocate([0n, 0n])],
    ["negative ratio", () => inr("1").allocate([1n, -1n])],
    [
      "number ratio",
      () => inr("1").allocate([1 as unknown as bigint, 1n]),
    ],
    ["zero parts", () => inr("1").allocateEvenly(0)],
    ["negative parts", () => inr("1").allocateEvenly(-2)],
    ["fractional parts", () => inr("1").allocateEvenly(1.5)],
    ["NaN parts", () => inr("1").allocateEvenly(Number.NaN)],
    ["too many parts", () => inr("1").allocateEvenly(MAX_ALLOCATION_PARTS + 1)],
  ])("rejects %s", (_name, op) => {
    expect(op).toThrow(InvalidAllocationError);
  });

  it("accepts the maximum part count", () => {
    const amount = BigInt(MAX_ALLOCATION_PARTS * 2 + 1);
    const shares = minors(Money.ofMinor(amount, INR).allocateEvenly(MAX_ALLOCATION_PARTS));
    expect(shares).toHaveLength(MAX_ALLOCATION_PARTS);
    expect(shares[0]).toBe(3n);
    expect(shares[1]).toBe(2n);
    expect(shares.reduce((a, b) => a + b, 0n)).toBe(amount);
  });
});

describe("toDecimalString", () => {
  it.each([
    [0n, INR, "0.00"],
    [1n, INR, "0.01"],
    [-1n, INR, "-0.01"],
    [10n, INR, "0.10"],
    [123456n, INR, "1234.56"],
    [-123456n, INR, "-1234.56"],
    [1500n, JPY, "1500"],
    [-7n, JPY, "-7"],
    [1n, KWD, "0.001"],
    [-1234n, KWD, "-1.234"],
  ])("formats %s minor units", (minor, cur, expected) => {
    expect(Money.ofMinor(minor, cur).toDecimalString()).toBe(expected);
  });

  it("round-trips through parse", () => {
    for (const input of ["0.00", "-0.01", "1234567.89", "-99.90"]) {
      expect(inr(input).toDecimalString()).toBe(input);
    }
  });

  it("has a readable toString", () => {
    expect(inr("-5.5").toString()).toBe("INR -5.50");
  });
});

describe("format", () => {
  it("uses Indian digit grouping for INR by default", () => {
    expect(inr("123456.78").format()).toBe("₹1,23,456.78");
    expect(inr("0").format()).toBe("₹0.00");
    expect(inr("-1500").format()).toBe("-₹1,500.00");
  });

  it("formats values beyond float precision without loss", () => {
    const big = Money.parse("9007199254740993.07", INR);
    expect(big.format()).toBe("₹9,00,71,99,25,47,40,993.07");
    expect(big.format({ locale: "en-US" })).toBe("₹9,007,199,254,740,993.07");
  });

  it("always shows exactly the currency's minor digits", () => {
    expect(Money.parse("1500", JPY).format({ locale: "en-US" })).toBe(
      "¥1,500",
    );
    expect(Money.parse("1.2", KWD).format({ locale: "en-US", currencyDisplay: "code" })).toMatch(
      /^KWD\s1\.200$/,
    );
  });

  it("supports other locales and displays", () => {
    expect(Money.parse("1234.5", USD).format({ locale: "en-US" })).toBe(
      "$1,234.50",
    );
    expect(inr("10").format({ currencyDisplay: "code" })).toMatch(
      /^INR\s10\.00$/,
    );
  });
});
