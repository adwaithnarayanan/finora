import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ACCOUNT_LEDGER_KIND, FINANCIAL_ACCOUNT_TYPES } from "@/domain/finance";

import { preflightHintQuery } from "../support/migration-hint";

const SQL = readFileSync(
  path.join(
    process.cwd(),
    "prisma/migrations/20261025000700_account_ledger_class/migration.sql",
  ),
  "utf8",
);
const hint = preflightHintQuery(SQL);

describe("the preflight's operator hint", () => {
  it("does not depend on anything the refused (rolled-back) migration creates", () => {
    expect(hint).not.toMatch(/financial_account_ledger_kind/);
  });

  it("maps every account type exactly as the application does, and nothing else", () => {
    const mapped = [...hint.matchAll(/WHEN '([a-z_]+)' THEN '([a-z]+)'/g)].map(
      (m) => [m[1], m[2]],
    );
    expect(Object.fromEntries(mapped)).toEqual(ACCOUNT_LEDGER_KIND);
    expect(mapped).toHaveLength(FINANCIAL_ACCOUNT_TYPES.length);
    expect(hint).not.toMatch(/\bELSE\b/);
    expect(hint).toMatch(
      /WHERE la\.kind::text IS DISTINCT FROM CASE fa\.type::text /,
    );
  });

  it("is one read-only SELECT that lists ids, type and kind but no names", () => {
    expect(hint).toMatch(
      /^SELECT fa\.id, fa\.owner_id, fa\.type, la\.kind FROM finora\.financial_accounts fa JOIN finora\.ledger_accounts la /,
    );
    expect(hint.indexOf(";")).toBe(hint.length - 1);
    expect(hint).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|GRANT|name)\b/i,
    );
  });

  it("leaves the preflight itself checking through the mapping function, unweakened", () => {
    expect(SQL).toContain(
      'WHERE la.kind IS DISTINCT FROM "finora"."financial_account_ledger_kind"(fa.type);',
    );
    expect(SQL).toContain("IF mismatched > 0 THEN");
  });
});
