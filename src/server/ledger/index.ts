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
 * `requireOwner()`. No route or server action exposes it directly: user-facing
 * features post through the finance service's server-side templates
 * (src/server/finance), so clients never submit journal lines.
 */
export const ledger = createLedgerService(withLedgerStore);
