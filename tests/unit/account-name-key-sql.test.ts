import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalAccountName } from "@/domain/finance";

import {
  accountNameKeySql,
  caseTables,
  extractGeneratedBlock,
  textCodePoints,
} from "../../scripts/lib/account-name-key-sql.mjs";
import {
  analyseAccountNames,
  blockingProblems,
  formatReport,
} from "../../scripts/lib/account-names.mjs";

const root = process.cwd();
const MIGRATION = path.join(
  root,
  "prisma/migrations/20261025000500_account_name_key/migration.sql",
);
const tables = caseTables();
const ignorable = new Set(tables.ignorable);
const cased = new Set(tables.cased);

const appKey = (s: string) => s.normalize("NFC").toLowerCase().normalize("NFC");

function sqlModelKey(input: string): string {
  const cps = [...input.normalize("NFC")].map((c) => c.codePointAt(0)!);
  const nearest = (i: number, dir: 1 | -1) => {
    let j = i + dir;
    while (j >= 0 && j < cps.length && ignorable.has(cps[j]!)) j += dir;
    return cps[j];
  };
  const lowered = cps.map((cp, i) => {
    if (cp !== 0x3a3) return tables.lower.get(cp) ?? String.fromCodePoint(cp);
    const before = nearest(i, -1);
    const after = nearest(i, 1);
    return before !== undefined &&
      cased.has(before) &&
      !(after !== undefined && cased.has(after))
      ? "\u03c2"
      : "\u03c3";
  });
  return lowered.join("").normalize("NFC");
}

function mismatches(inputs: Iterable<string>, limit = 10): string[] {
  const found: string[] = [];
  for (const input of inputs) {
    if (sqlModelKey(input) !== appKey(input)) found.push(JSON.stringify(input));
    if (found.length >= limit) break;
  }
  return found;
}

function* map<T, U>(items: Iterable<T>, fn: (item: T) => U): Iterable<U> {
  for (const item of items) yield fn(item);
}

function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("pinned runtime", () => {
  it("runs on the Node version pinned in .nvmrc and package.json engines", () => {
    const pinned = readFileSync(path.join(root, ".nvmrc"), "utf8").trim();
    const engines = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8"),
    ).engines.node;
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    expect(engines).toBe(pinned);
    expect(process.version).toBe(`v${pinned}`);
  });

  it("has the Unicode data documented in ADR 0007", () => {
    expect({
      icu: process.versions.icu,
      unicode: process.versions.unicode,
    }).toEqual({ icu: "78.3", unicode: "17.0" });
  });
});

describe("generated SQL in migration 20261025000500", () => {
  it("is exactly what the generator produces on this runtime", () => {
    const block = extractGeneratedBlock(readFileSync(MIGRATION, "utf8"));
    expect(block).not.toBeNull();
    expect(block).toBe(accountNameKeySql(tables));
  });

  it("keeps the migration pure ASCII, so no editor can re-normalise it", () => {
    expect(readFileSync(MIGRATION, "utf8")).toMatch(
      /^[\x09\x0a\x0d\x20-\x7e]*$/,
    );
  });

  it("sets its lock timeout and checks for PostgreSQL 17 before any other statement", () => {
    const statements = readFileSync(MIGRATION, "utf8")
      .split("\n")
      .filter(
        (line) => line.trim() !== "" && !line.trimStart().startsWith("--"),
      );
    expect(statements[0]).toBe("SET LOCAL lock_timeout = '5s';");
    expect(statements.slice(1, 4)).toEqual([
      "DO $$",
      "BEGIN",
      "  IF current_setting('server_version_num')::integer < 170000 THEN",
    ]);
  });
});

const EXHAUSTIVE = 60_000;

describe("JavaScript model of the generated SQL", () => {
  it(
    "agrees with the application for every code point on its own",
    () => {
      expect(
        mismatches(map(textCodePoints(), (cp) => String.fromCodePoint(cp))),
      ).toEqual([]);
    },
    EXHAUSTIVE,
  );

  it(
    "agrees on Final_Sigma with every code point following a capital sigma",
    () => {
      expect(
        mismatches(
          map(textCodePoints(), (cp) => `A\u03a3${String.fromCodePoint(cp)}`),
        ),
      ).toEqual([]);
      expect(
        mismatches(
          map(textCodePoints(), (cp) => `A\u03a3${String.fromCodePoint(cp)}b`),
        ),
      ).toEqual([]);
      expect(
        mismatches(
          map(textCodePoints(), (cp) => `${String.fromCodePoint(cp)}\u03a3`),
        ),
      ).toEqual([]);
    },
    EXHAUSTIVE,
  );

  it(
    "agrees on random strings rich in Greek, combining marks and special cases",
    () => {
      const pool = [
        ..."ABCabc1 .-'",
        ..."\u03a3\u03c3\u03c2\u0391\u03b1\u0390\u1f88\u0345",
        ..."\u0130\u0131Ii\u0307\u00df\u1e9e\u212a\u212b\u01c5\u01c4",
        ..."\u0300\u0301\u0323\u0327\u00ad\u200d\u2019\u00b7",
        ...[...tables.ignorable.slice(0, 40), ...tables.cased.slice(-40)].map(
          (cp) => String.fromCodePoint(cp),
        ),
        "\u{10400}",
        "\u{1e900}",
        "\u{16e40}",
      ];
      const next = random(20261025);
      const strings = Array.from({ length: 50_000 }, () =>
        Array.from(
          { length: 1 + Math.floor(next() * 8) },
          () => pool[Math.floor(next() * pool.length)],
        ).join(""),
      );
      expect(mismatches(strings)).toEqual([]);
    },
    EXHAUSTIVE,
  );

  it(
    "treats as whitespace exactly what trim() removes",
    () => {
      for (const cp of textCodePoints()) {
        const c = String.fromCodePoint(cp);
        if ((c.trim() === "") !== tables.space.includes(cp))
          throw new Error(`U+${cp.toString(16)}`);
      }
      expect(tables.space).toContain(0xfeff);
      expect(tables.space).not.toContain(0x200b);
    },
    EXHAUSTIVE,
  );
});

describe("account-name analysis (db:account-names)", () => {
  const owner = "11111111-1111-4111-8111-111111111111";
  const other = "22222222-2222-4222-8222-222222222222";
  const row = (
    id: string,
    name: string,
    extra: Partial<{
      ownerId: string;
      assigned: boolean;
      nameKey: string;
    }> = {},
  ) => ({
    id,
    ownerId: owner,
    name,
    assigned: true,
    ...extra,
  });

  it("groups names by owner and application key, and reports ids only", () => {
    const analysis = analyseAccountNames(
      [
        row("a1", "Caf\u00e9"),
        row("a2", "CAFE\u0301"),
        row("a3", "Stra\u00dfe"),
        row("a4", "STRASSE"),
        row("a5", "Caf\u00e9", { ownerId: other }),
        row("a6", "\u039f\u0394\u039f\u03a3"),
        row("a7", "\u03bf\u03b4\u03bf\u03c2"),
      ],
      { mode: "preflight" },
    );
    expect(analysis.conflicts).toEqual([
      { ownerId: owner, accountIds: ["a1", "a2"] },
      { ownerId: owner, accountIds: ["a6", "a7"] },
    ]);
    expect(analysis.notNfc).toEqual(["a2"]);
    const report = formatReport(analysis);
    expect(report).toContain(`owner ${owner}: accounts a1, a2`);
    for (const name of ["Caf", "Stra", "STRASSE", "\u039f\u0394"])
      expect(report).not.toContain(name);
    expect(blockingProblems(analysis)).toEqual([
      "2 group(s) of names sharing a comparison key",
    ]);
  });

  it("preflight: flags the rows the migration refuses", () => {
    const analysis = analyseAccountNames(
      [
        row("b1", "\u00a0Cash"),
        row("b2", "Ok", { assigned: false }),
        row("b3", "\u0958".repeat(31)), // each NFCs to two code points
        row("b4", "Cafe\u0301"), // rewritten by the migration: not a problem
      ],
      { mode: "preflight" },
    );
    expect(analysis).toMatchObject({
      untrimmed: ["b1"],
      unsupported: ["b2"],
      tooLong: ["b3"],
      notNfc: ["b3", "b4"],
    });
    expect(blockingProblems(analysis)).toHaveLength(3);
    expect(formatReport(analysis)).toContain(
      "Names the migration will rewrite to NFC (not a problem): 2",
    );
  });

  it("verify: flags stored names and keys that are not the application's", () => {
    const analysis = analyseAccountNames(
      [
        row("c1", "\u00a0Cash", { nameKey: "\u00a0cash" }),
        row("c2", "\u0958".repeat(31), { nameKey: "x" }),
        row("c3", "Bank", { nameKey: "Bank" }),
        row("c4", "bank", { nameKey: "bank", ownerId: other }),
        row("c5", "Cafe\u0301", { nameKey: "caf\u00e9" }), // display name left in NFD
        row("c6", "Caf\u00e9", { nameKey: "caf\u00e9" }), // same key as c5, same owner
      ],
      { mode: "verify" },
    );
    expect(analysis).toMatchObject({
      untrimmed: ["c1"],
      tooLong: ["c2"],
      nameNotCanonical: ["c1", "c2", "c5"],
      keyMismatch: ["c1", "c2", "c3"],
      conflicts: [{ ownerId: owner, accountIds: ["c5", "c6"] }],
    });
    expect(blockingProblems(analysis)).toHaveLength(5);
    const report = formatReport(analysis);
    expect(report).toContain("Stored name not canonical (trimmed NFC): 3");
    expect(report).not.toContain("will rewrite");
    expect(canonicalAccountName("Bank").key).toBe("bank");
  });

  it("verify: a canonical name with a character the server's Unicode lacks is not a problem", () => {
    const name = canonicalAccountName("Bank \u1c89");
    expect(name.key).not.toBe(name.display);
    const rows = [
      row("d1", name.display, { assigned: false, nameKey: name.key }),
    ];

    const verified = analyseAccountNames(rows, { mode: "verify" });
    expect(blockingProblems(verified)).toEqual([]);
    expect(formatReport(verified)).not.toContain("unassigned");
    expect(
      analyseAccountNames([{ ...rows[0]!, nameKey: name.display }], {
        mode: "verify",
      }).keyMismatch,
    ).toEqual(["d1"]);
    expect(
      blockingProblems(analyseAccountNames(rows, { mode: "preflight" })),
    ).toEqual(["1 name(s) with characters unassigned in the server's Unicode"]);
  });

  it("rejects an unknown mode", () => {
    expect(() => analyseAccountNames([], { mode: "check" } as never)).toThrow(
      /unknown analysis mode/,
    );
  });
});
