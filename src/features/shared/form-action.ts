import "server-only";

import { redirect } from "next/navigation";

import type { AuthorizedOwner } from "@/server/auth/types";
import { requireOwner } from "@/server/auth/session";

import { toActionState } from "./errors";
import { type ActionState, formEntries } from "./form-state";

type FormOutcome = { message: string } | { redirectTo: string };

/**
 * Runs a form's server action for the signed-in owner. A refused submission
 * comes back as form state with the submitted values (see `toActionState`;
 * unexpected errors still reach the error boundary). The redirect runs after
 * the try block because `redirect()` throws a control-flow exception.
 */
export async function runFormAction(
  formData: FormData,
  handler: (
    owner: AuthorizedOwner,
    input: Record<string, string>,
  ) => Promise<FormOutcome>,
  refineError: (
    state: ActionState,
    input: Record<string, string>,
  ) => ActionState = (state) => state,
): Promise<ActionState> {
  const owner = await requireOwner();
  const input = formEntries(formData);
  let outcome: FormOutcome;
  try {
    outcome = await handler(owner, input);
  } catch (error) {
    return { ...refineError(toActionState(error), input), values: input };
  }
  if ("redirectTo" in outcome) redirect(outcome.redirectTo);
  return { message: outcome.message };
}
