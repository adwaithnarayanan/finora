import type { LedgerIssue } from "./validation";

/** Base class for every error raised by the ledger domain. */
export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A single input value (id, date, text, key) is malformed. */
export class InvalidLedgerInputError extends LedgerError {}

export class InvalidIdempotencyKeyError extends InvalidLedgerInputError {}

/** Journal lines are invalid or do not balance; `issues` lists every problem found. */
export class LedgerValidationError extends LedgerError {
  readonly issues: readonly LedgerIssue[];

  constructor(issues: readonly LedgerIssue[]) {
    super(`Journal entry is invalid: ${issues.map((i) => i.code).join(", ")}`);
    this.issues = Object.freeze([...issues]);
  }
}

/** The operation needs a draft, but the entry is already posted. */
export class EntryNotDraftError extends LedgerError {
  constructor() {
    super("Journal entry is posted; posted entries cannot be changed");
  }
}

export type NotReversibleReason = "not-posted" | "is-reversal";

/** Only posted entries that are not themselves reversals can be reversed. */
export class EntryNotReversibleError extends LedgerError {
  constructor(readonly reason: NotReversibleReason) {
    super(
      reason === "not-posted"
        ? "Only posted journal entries can be reversed"
        : "A reversal cannot itself be reversed; post a new entry instead",
    );
  }
}

/** Each posted entry can be reversed exactly once. */
export class EntryAlreadyReversedError extends LedgerError {
  constructor() {
    super("Journal entry has already been reversed");
  }
}
