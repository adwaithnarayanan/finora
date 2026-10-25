import { LedgerError } from "@/domain/ledger";

/**
 * The entry or account does not exist for this owner. Other owners' records
 * produce exactly the same error, so ids reveal nothing across owners.
 */
export class LedgerNotFoundError extends LedgerError {
  constructor(readonly resource: "entry" | "account") {
    super(resource === "entry" ? "Journal entry not found" : "Ledger account not found");
  }
}

/** The idempotency key was already used for a different request. */
export class IdempotencyConflictError extends LedgerError {
  constructor() {
    super("Idempotency key was already used for a different request");
  }
}

export class DuplicateLedgerAccountError extends LedgerError {
  constructor() {
    super("A ledger account with this name already exists");
  }
}

/**
 * The database refused the change (constraint, trigger or RLS). Indicates an
 * application bug or a race the domain checks did not catch; the change was
 * rolled back in full. `reason` is Finora's own trigger message, never a raw
 * database error (which could include values or configuration).
 */
export class LedgerIntegrityError extends LedgerError {
  constructor(readonly reason: string) {
    super(`The ledger rejected the change: ${reason}`);
  }
}
