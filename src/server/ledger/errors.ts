import { LedgerError } from "@/domain/ledger";

export class LedgerNotFoundError extends LedgerError {
  constructor(readonly resource: "entry" | "account") {
    super(
      resource === "entry"
        ? "Journal entry not found"
        : "Ledger account not found",
    );
  }
}

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

export class LedgerIntegrityError extends LedgerError {
  constructor(readonly reason: string) {
    super(`The ledger rejected the change: ${reason}`);
  }
}
