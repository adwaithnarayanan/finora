"use client";

import { useActionState } from "react";

import { type ActionState, INITIAL_STATE } from "./form-state";

/** `useActionState` for a server action, with the per-field errors and echoed values forms read. */
export function useFormAction(
  serverAction: (prev: ActionState, formData: FormData) => Promise<ActionState>,
  initialState: ActionState = INITIAL_STATE,
) {
  const [state, action, pending] = useActionState(serverAction, initialState);
  return {
    state,
    action,
    pending,
    errors: state.fieldErrors ?? {},
    values: state.values ?? {},
  };
}
