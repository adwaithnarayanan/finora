"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";

import { FormError } from "../shared/field";
import { type ActionState, INITIAL_STATE } from "../shared/form-state";
import { initializeDefaultCategoriesAction } from "./actions";

/** Creates the default income and expense categories when the owner asks for them. */
export function DefaultCategoriesButton({ returnTo }: { returnTo?: "/transactions/new" }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(initializeDefaultCategoriesAction, INITIAL_STATE);
  return (
    <form action={action} className="grid justify-items-start gap-2">
      {returnTo ? <input type="hidden" name="returnTo" value={returnTo} /> : null}
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? "Adding default categories…" : "Add default categories"}
      </Button>
      <FormError state={state} />
    </form>
  );
}
