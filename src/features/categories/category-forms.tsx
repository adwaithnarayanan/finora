"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { Field, FormError } from "../shared/field";
import { SelectField } from "../shared/select-field";
import { useFormAction } from "../shared/use-form-action";
import { createCategoryAction, renameCategoryAction } from "./actions";

const KINDS = [
  { value: "expense", label: "Expense" },
  { value: "income", label: "Income" },
] as const;

export function CreateCategoryForm() {
  const { state, action, pending, errors, values: echoed } = useFormAction(createCategoryAction);
  const values = state.error ? echoed : {};
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-[1fr_12rem_auto] sm:items-end" noValidate>
      <Field name="name" label="New category" error={errors["name"]}>
        {(props) => <Input {...props} maxLength={60} autoComplete="off" defaultValue={values["name"]} required />}
      </Field>
      <SelectField
        name="kind"
        label="Kind"
        error={errors["kind"]}
        options={KINDS}
        defaultValue={values["kind"] ?? "expense"}
      />
      <Button type="submit" loading={pending} loadingText="Adding…">Add category</Button>
      <div className="sm:col-span-3">
        <FormError state={state} />
      </div>
    </form>
  );
}

export function RenameCategoryForm({ id, name }: { id: string; name: string }) {
  const { state, action, pending } = useFormAction(renameCategoryAction);
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
      <Button type="submit" loading={pending} loadingText="Saving…" variant="ghost" size="sm">
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
