import { describe, expect, it } from "vitest";

import {
  INR,
  InvalidCurrencyError,
  KNOWN_CURRENCIES,
  MAX_CURRENCY_EXPONENT,
  currency,
  defineCurrency,
  sameCurrency,
} from "./index";

describe("currency", () => {
  it("defines INR with two minor digits", () => {
    expect(INR).toEqual({ code: "INR", exponent: 2 });
    expect(currency("INR")).toBe(INR);
  });

  it("knows currencies with non-two exponents", () => {
    expect(currency("JPY").exponent).toBe(0);
    expect(currency("KWD").exponent).toBe(3);
  });

  it("refuses to guess an exponent for unknown codes", () => {
    expect(() => currency("XYZ")).toThrow(InvalidCurrencyError);
    expect(() => currency("inr")).toThrow(InvalidCurrencyError);
    expect(() => currency("toString")).toThrow(InvalidCurrencyError);
    expect(() => currency("__proto__")).toThrow(InvalidCurrencyError);
  });

  it("defines custom currencies explicitly", () => {
    const btc = defineCurrency("XBT", MAX_CURRENCY_EXPONENT);
    expect(btc).toEqual({ code: "XBT", exponent: MAX_CURRENCY_EXPONENT });
    expect(Object.isFrozen(btc)).toBe(true);
    expect(defineCurrency("CLF", 0).exponent).toBe(0);
  });

  it.each(["", "IN", "INRR", "inr", "In1", " INR", 42])(
    "rejects code %j",
    (code) => {
      expect(() => defineCurrency(code as string, 2)).toThrow(
        InvalidCurrencyError,
      );
    },
  );

  it.each([-1, 1.5, MAX_CURRENCY_EXPONENT + 1, Number.NaN, Infinity])(
    "rejects exponent %s",
    (exponent) => {
      expect(() => defineCurrency("INR", exponent)).toThrow(
        InvalidCurrencyError,
      );
    },
  );

  it("compares currencies structurally", () => {
    expect(sameCurrency(INR, defineCurrency("INR", 2))).toBe(true);
    expect(sameCurrency(INR, defineCurrency("INR", 3))).toBe(false);
    expect(sameCurrency(INR, KNOWN_CURRENCIES.USD)).toBe(false);
  });

  it("freezes the registry", () => {
    expect(Object.isFrozen(KNOWN_CURRENCIES)).toBe(true);
    expect(Object.isFrozen(INR)).toBe(true);
  });
});
