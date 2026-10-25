"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";

import { Field, FormError } from "../shared/field";
import { type ActionState, INITIAL_STATE } from "../shared/form-state";
import { createCategoryAction, renameCategoryAction } from "./actions";

export function CreateCategoryForm() {
  const [state, action, pending] = useActionState<ActionState, FormData>(createCategoryAction, INITIAL_STATE);
  const errors = state.fieldErrors ?? {};
  const values = state.error ? (state.values ?? {}) : {};
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-[1fr_12rem_auto] sm:items-end" noValidate>
      <Field name="name" label="New category" error={errors["name"]}>
        {(props) => <Input {...props} maxLength={60} autoComplete="off" defaultValue={values["name"]} required />}
      </Field>
      <Field name="kind" label="Kind" error={errors["kind"]}>
        {(props) => (
          <NativeSelect {...props} defaultValue={values["kind"] ?? "expense"}>
            <option value="expense">Expense</option>
            <option value="income">Income</option>
          </NativeSelect>
        )}
      </Field>
      <Button type="submit" disabled={pending}>
        {pending ? "Adding…" : "Add category"}
      </Button>
      <div className="sm:col-span-3">
        <FormError state={state} />
      </div>
    </form>
  );
}

export function RenameCategoryForm({ id, name }: { id: string; name: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(renameCategoryAction, INITIAL_STATE);
  const field = `name-${id}`;
  return (
    <form action={action} className="flex flex-wrap items-center gap-2" noValidate>
      <input type="hidden" name="categoryId" value={id} />
      <label htmlFor={field} className="sr-only">
        Name for {name}
      </label>
      <Input
        id={field}
        name="name"
        defaultValue={state.values?.["name"] ?? name}
        maxLength={60}
        className="h-7 w-48"
        aria-invalid={state.error ? true : undefined}
      />
      <Button type="submit" variant="ghost" size="sm" disabled={pending}>
        Rename
      </Button>
      {state.error ? (
        <span role="alert" className="text-xs text-destructive">
          {state.fieldErrors?.["name"] ?? state.error}
        </span>
      ) : null}
    </form>
  );
}
