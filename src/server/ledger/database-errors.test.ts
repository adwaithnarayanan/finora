import { describe, expect, it } from "vitest";

import { LedgerValidationError } from "@/domain/ledger";

import { translateDatabaseError, sqlStates } from "./database-errors";
import { LedgerIntegrityError } from "./errors";

/** Shapes observed from @prisma/adapter-pg 7.10.1 against PostgreSQL 17. */
const knownRequestError = (code: string, originalCode: string) =>
  Object.assign(new Error("\nInvalid `tx.journalLine.createMany()` invocation in /src/x.ts:1:1\n\n  INSERT ..."), {
    name: "PrismaClientKnownRequestError",
    code,
    meta: { driverAdapterError: { name: "DriverAdapterError", cause: { originalCode, kind: "postgres" } } },
  });

const commitError = (message: string) =>
  Object.assign(new Error(message), { name: "DriverAdapterError", cause: { originalCode: "23514" } });

function translated(error: unknown): unknown {
  try {
    translateDatabaseError(error);
  } catch (thrown) {
    return thrown;
  }
  throw new Error("expected a throw");
}

describe("translateDatabaseError", () => {
  it("keeps only Finora's own trigger reason", () => {
    const error = translated(commitError("finora.ledger: posted journal entry is unbalanced\nCONTEXT: PL/pgSQL ..."));
    expect(error).toBeInstanceOf(LedgerIntegrityError);
    expect(error).toMatchObject({
      reason: "posted journal entry is unbalanced",
      message: "The ledger rejected the change: posted journal entry is unbalanced",
    });
  });

  it.each([
    ["foreign key", "P2003", "23503"],
    ["check", "P2010", "23514"],
    ["unique", "P2002", "23505"],
    ["row-level security", "P2010", "42501"],
  ])("maps a %s violation to a generic integrity error without SQL", (_label, code, sqlstate) => {
    const error = translated(knownRequestError(code, sqlstate)) as Error;
    expect(error).toBeInstanceOf(LedgerIntegrityError);
    expect(error.message).toBe("The ledger rejected the change: constraint violation");
    expect(error.message).not.toMatch(/INSERT|invocation|\.ts/);
  });

  it("rethrows ledger errors and non-integrity failures unchanged", () => {
    const validation = new LedgerValidationError([{ code: "no-lines" }]);
    expect(translated(validation)).toBe(validation);
    const timeout = knownRequestError("P2010", "57014"); // statement timeout
    expect(translated(timeout)).toBe(timeout);
    const connection = new Error("connect ECONNREFUSED");
    expect(translated(connection)).toBe(connection);
    expect(translated("not an error")).toBe("not an error");
  });
});

describe("sqlStates", () => {
  it("finds nested PostgreSQL codes and tolerates odd shapes", () => {
    expect(sqlStates(knownRequestError("P2003", "23503"))).toEqual(["P2003", "23503"]);
    expect(sqlStates(null)).toEqual([]);
    expect(sqlStates({ code: 23503, cause: { cause: { cause: { cause: { cause: { code: "23505" } } } } } })).toEqual([]);
  });
});
