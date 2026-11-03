"use client";

import { Button } from "@/components/ui/button";

import { FormError } from "../shared/field";
import { useFormAction } from "../shared/use-form-action";
import { initializeDefaultCategoriesAction } from "./actions";

export function DefaultCategoriesButton({
  returnTo,
}: {
  returnTo?: "/transactions/new";
}) {
  const { state, action, pending } = useFormAction(
    initializeDefaultCategoriesAction,
  );
  return (
    <form action={action} className="grid justify-items-start gap-2">
      {returnTo ? (
        <input type="hidden" name="returnTo" value={returnTo} />
      ) : null}
      <Button
        type="submit"
        loading={pending}
        loadingText="Adding default categories…"
        variant="outline"
        size="sm"
      >
        Add default categories
      </Button>
      <FormError state={state} />
    </form>
  );
}
