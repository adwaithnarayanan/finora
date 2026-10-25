import { describe, expect, it } from "vitest";

import { InvalidFinanceInputError, canonicalAccountName, parseAccountName } from "./index";

const key = (name: string) => canonicalAccountName(name).key;
const display = (name: string) => canonicalAccountName(name).display;
const cp = (s: string) => [...s].map((c) => c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")).join(" ");

/**
 * The exact policy of ADR 0007. Equalities and inequalities are both
 * asserted: neither may change without a decision (and a re-key migration).
 */
describe("canonicalAccountName", () => {
  it("trims ECMAScript whitespace at both ends and keeps inner spacing", () => {
    expect(display("  HDFC  Savings \t")).toBe("HDFC  Savings");
    expect(display("\u00a0\u3000\ufeffCash\u2028\n")).toBe("Cash");
    expect(key(" Cash ")).toBe(key("Cash"));
    // Not whitespace to trim(): zero-width space stays (and so differs).
    expect(display("\u200bCash")).toBe("\u200bCash");
    expect(key("\u200bCash")).not.toBe(key("Cash"));
  });

  it("stores NFC: NFC and NFD input are the same canonical name", () => {
    const nfc = "Caf\u00e9";
    const nfd = "Cafe\u0301";
    expect(display(nfd)).toBe(nfc);
    expect(cp(display(nfd))).toBe("0043 0061 0066 00E9");
    expect(key(nfd)).toBe(key(nfc));
    // Canonical reordering of combining marks (dot below 0323 before dot above 0307).
    expect(display("s\u0307\u0323")).toBe("\u1e69");
    expect(key("S\u0323\u0307")).toBe(key("\u1e69"));
  });

  it("never applies compatibility normalisation (no NFKC)", () => {
    expect(display("\ufb01le")).toBe("\ufb01le"); // the "fi" ligature is kept
    expect(key("\ufb01le")).not.toBe(key("file"));
    expect(key("\uff21")).not.toBe(key("A")); // fullwidth A
    expect(key("\u2460")).not.toBe(key("1")); // circled digit one
  });

  it("matches ordinary ASCII letter-case variants and keeps the display as typed", () => {
    expect(key("HDFC Savings")).toBe("hdfc savings");
    expect(key("hdfc SAVINGS")).toBe("hdfc savings");
    expect(display("hdfc SAVINGS")).toBe("hdfc SAVINGS");
    expect(key("Wallet_1")).not.toBe(key("Wallet-1"));
  });

  it("matches accented Latin case variants, but not unaccented letters", () => {
    expect(key("\u00c9COLE")).toBe(key("\u00e9cole"));
    expect(key("E\u0301COLE")).toBe(key("\u00e9cole")); // NFD capital
    expect(key("\u00c5ngstr\u00f6m")).toBe(key("\u00e5NGSTR\u00d6M"));
    expect(key("\u212bngstr\u00f6m")).toBe(key("\u00e5ngstr\u00f6m")); // ANGSTROM SIGN is canonically \u00c5
    expect(key("Ecole")).not.toBe(key("\u00e9cole"));
  });

  it("lower-cases Turkish dotted capital I to i + combining dot (no Turkish tailoring)", () => {
    expect(cp(key("\u0130stanbul"))).toBe(cp("i\u0307stanbul"));
    expect(key("\u0130STANBUL")).toBe(key("i\u0307stanbul"));
    expect(key("\u0130stanbul")).not.toBe(key("Istanbul"));
    expect(key("ISTANBUL")).toBe("istanbul");
    // Dotless i is its own letter; its capital is plain I, which lowers to i.
    expect(key("\u0131stanbul")).not.toBe(key("istanbul"));
    expect(key("\u0131stanbul")).not.toBe(key("\u0130stanbul"));
  });

  it("applies Final_Sigma: capital sigma lowers to final sigma only at the end of a word", () => {
    expect(key("\u039f\u0394\u039f\u03a3")).toBe("\u03bf\u03b4\u03bf\u03c2"); // capital "odos" ends in final sigma
    expect(key("\u039f\u03b4\u03bf\u03c2")).toBe("\u03bf\u03b4\u03bf\u03c2");
    expect(key("\u03a3\u0391\u03a3 \u03a3\u0391\u03a3")).toBe("\u03c3\u03b1\u03c2 \u03c3\u03b1\u03c2");
    expect(key("\u03a3")).toBe("\u03c3"); // alone: not preceded by a cased letter
    expect(key("\u039f\u03a3\u0301")).toBe("\u03bf\u03c2\u0301"); // a following combining mark is ignored
    // Lower-casing, not folding: a medial sigma written at the end differs.
    expect(key("\u03bf\u03b4\u03bf\u03c3")).not.toBe(key("\u039f\u0394\u039f\u03a3"));
    expect(key("\u03bf\u03b4\u03bf\u03c3")).not.toBe(key("\u03bf\u03b4\u03bf\u03c2"));
  });

  it("keeps sharp s and ss different (lower-casing, not case folding)", () => {
    expect(key("Stra\u00dfe")).toBe("stra\u00dfe");
    expect(key("STRASSE")).toBe("strasse");
    expect(key("Stra\u00dfe")).not.toBe(key("STRASSE"));
    expect(key("STRA\u1e9eE")).toBe(key("stra\u00dfe")); // capital sharp s lowers to \u00df
  });

  it("is idempotent", () => {
    for (const name of ["  Cafe\u0301 ", "\u0130STANBUL", "\u039f\u0394\u039f\u03a3", "STRA\u1e9eE", "\u212b", "s\u0307\u0323"]) {
      const once = canonicalAccountName(name);
      const twice = canonicalAccountName(once.display);
      expect(twice).toEqual(once);
      expect(canonicalAccountName(once.key).key).toBe(once.key);
    }
  });
});

describe("parseAccountName", () => {
  it("returns the canonical name", () => {
    expect(parseAccountName("  Cafe\u0301 ")).toEqual(canonicalAccountName("Caf\u00e9"));
  });

  it("rejects missing, blank and over-long names", () => {
    expect(() => parseAccountName(undefined)).toThrow(new InvalidFinanceInputError("Account name is required"));
    expect(() => parseAccountName(" \u3000 ")).toThrow("Account name is required");
    expect(() => parseAccountName("x".repeat(61))).toThrow("Account name must be at most 60 characters");
  });

  it("measures the length after NFC", () => {
    const nfd = "e\u0301".repeat(60); // 120 code units as typed, 60 after NFC
    expect(parseAccountName(nfd).display).toBe("\u00e9".repeat(60));
  });
});
