import "server-only";

import { FinanceError, FinanceValidationError } from "@/domain/finance";
import { LedgerError } from "@/domain/ledger";
import {
  IdempotencyConflictError,
  LedgerIntegrityError,
} from "@/server/ledger";

import type { ActionState } from "./form-state";

export function toActionState(error: unknown): ActionState {
  if (error instanceof FinanceValidationError) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of error.issues)
      fieldErrors[issue.field] ??= issue.message;
    return { error: "Check the highlighted fields.", fieldErrors };
  }
  if (error instanceof IdempotencyConflictError) {
    return {
      error:
        "This form was already submitted with different details. Reload the page and try again.",
    };
  }
  if (error instanceof LedgerIntegrityError) {
    return {
      error:
        "The ledger refused this change, so nothing was saved. Reload the page and try again.",
    };
  }
  if (error instanceof FinanceError || error instanceof LedgerError)
    return { error: error.message };
  throw error;
}

export function toActionStateOrFallback(
  error: unknown,
  fallback: string,
  log: (error: unknown) => void = (e) =>
    console.error("finora: server action failed", e),
): ActionState {
  try {
    return toActionState(error);
  } catch {
    log(error);
    return { error: fallback };
  }
}
