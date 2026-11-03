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

export const ledger = createLedgerService(withLedgerStore);
