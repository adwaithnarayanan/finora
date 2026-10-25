import "server-only";

import { withLedgerStore } from "@/server/db";

import { createLedgerService } from "./service";

export {
  DuplicateLedgerAccountError,
  IdempotencyConflictError,
  LedgerIntegrityError,
  LedgerNotFoundError,
} from "./errors";
export type {
  CorrectionInput,
  CorrectionResult,
  EntryInput,
  EntryResult,
  LedgerService,
} from "./service";

/**
 * The ledger API for server code. Callers pass the `AuthorizedOwner` from
 * `requireOwner()`; there is deliberately no route, server action or other
 * client-reachable entry point in this milestone.
 */
export const ledger = createLedgerService(withLedgerStore);
