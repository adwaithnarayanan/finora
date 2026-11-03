"use client";

import { useActionState } from "react";

import { type ActionState, INITIAL_STATE } from "./form-state";

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
