import { LedgerError } from "@/domain/ledger";

import { LedgerIntegrityError } from "./errors";

/** Database messages raised by Finora's own triggers start with this prefix. */
const TRIGGER_PREFIX = "finora.ledger: ";

/**
 * SQLSTATEs that mean "the database refused this change": class 23 (integrity
 * constraint violations) and 42501 (insufficient privilege, including RLS).
 */
const REFUSAL_SQLSTATE = /^(23[0-9A-Z]{3}|42501)$/;
const SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * Converts a database refusal into a LedgerIntegrityError carrying only
 * Finora's own reason text. Anything else (connection failures, timeouts) is
 * rethrown unchanged.
 */
export function translateDatabaseError(error: unknown): never {
  if (error instanceof LedgerError) throw error;
  const message = error instanceof Error ? error.message : "";
  const start = message.indexOf(TRIGGER_PREFIX);
  if (start !== -1) {
    const reason = message.slice(start + TRIGGER_PREFIX.length).split("\n")[0]!.trim();
    throw new LedgerIntegrityError(reason);
  }
  if (sqlStates(error).some((code) => REFUSAL_SQLSTATE.test(code))) {
    throw new LedgerIntegrityError("constraint violation");
  }
  throw error;
}

/**
 * PostgreSQL error codes found on a Prisma error. Driver-adapter errors nest
 * them (`meta.driverAdapterError.cause.originalCode`); errors raised at COMMIT
 * arrive as a bare DriverAdapterError. Prisma's own `P....` codes are ignored.
 */
export function sqlStates(error: unknown, depth = 0): string[] {
  if (depth > 4 || error === null || typeof error !== "object") return [];
  const record = error as Record<string, unknown>;
  const own = [record["code"], record["originalCode"]].filter(
    (c): c is string => typeof c === "string" && SQLSTATE.test(c),
  );
  const nested = ["meta", "driverAdapterError", "cause"].flatMap((key) => sqlStates(record[key], depth + 1));
  return [...own, ...nested];
}
