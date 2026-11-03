import type { LedgerIssue } from "./validation";

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidLedgerInputError extends LedgerError {}

export class InvalidIdempotencyKeyError extends InvalidLedgerInputError {}

export class LedgerValidationError extends LedgerError {
  readonly issues: readonly LedgerIssue[];

  constructor(issues: readonly LedgerIssue[]) {
    super(`Journal entry is invalid: ${issues.map((i) => i.code).join(", ")}`);
    this.issues = Object.freeze([...issues]);
  }
}

export class EntryNotDraftError extends LedgerError {
  constructor() {
    super("Journal entry is posted; posted entries cannot be changed");
  }
}

export type NotReversibleReason = "not-posted" | "is-reversal";

export class EntryNotReversibleError extends LedgerError {
  constructor(readonly reason: NotReversibleReason) {
    super(
      reason === "not-posted"
        ? "Only posted journal entries can be reversed"
        : "A reversal cannot itself be reversed; post a new entry instead",
    );
  }
}

export class EntryAlreadyReversedError extends LedgerError {
  constructor() {
    super("Journal entry has already been reversed");
  }
}
