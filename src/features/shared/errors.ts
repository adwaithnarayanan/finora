import "server-only";

import { FinanceError, FinanceValidationError } from "@/domain/finance";
import { LedgerError } from "@/domain/ledger";
import { IdempotencyConflictError, LedgerIntegrityError } from "@/server/ledger";

import type { ActionState } from "./form-state";

/**
 * Turns a service error into form state. Validation problems go next to
 * their fields; conflicts and not-found errors are shown as a form message.
 * Anything unexpected is rethrown (to the route's error boundary), so no
 * internal detail reaches the page.
 */
export function toActionState(error: unknown): ActionState {
  if (error instanceof FinanceValidationError) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of error.issues) fieldErrors[issue.field] ??= issue.message;
    return { error: "Check the highlighted fields.", fieldErrors };
  }
  if (error instanceof IdempotencyConflictError) {
    return { error: "This form was already submitted with different details. Reload the page and try again." };
  }
  if (error instanceof LedgerIntegrityError) {
    return { error: "The ledger refused this change, so nothing was saved. Reload the page and try again." };
  }
  if (error instanceof FinanceError || error instanceof LedgerError) return { error: error.message };
  throw error;
}

/**
 * For actions with no form to lose (a single button): like `toActionState`,
 * but an unexpected failure becomes the generic `fallback` message instead of
 * reaching the error boundary. Its details go to the server log only.
 */
export function toActionStateOrFallback(
  error: unknown,
  fallback: string,
  log: (error: unknown) => void = (e) => console.error("finora: server action failed", e),
): ActionState {
  try {
    return toActionState(error);
  } catch {
    log(error);
    return { error: fallback };
  }
}
