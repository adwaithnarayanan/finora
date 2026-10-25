"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";

import { Field, FormError } from "../shared/field";
import { type ActionState, INITIAL_STATE } from "../shared/form-state";
import { createAccountAction, setOpeningBalanceAction, updateAccountAction } from "./actions";

const OPENING_HINT =
  "Your balance on this date when you start tracking. It is recorded as an opening balance (a starting position), not as income.";

const TYPES = [
  { value: "bank", label: "Bank account" },
  { value: "cash", label: "Cash" },
] as const;

export function CreateAccountForm({
  idempotencyKey,
  today,
  currencies,
}: {
  idempotencyKey: string;
  today: string;
  currencies: readonly { code: string; label: string }[];
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(createAccountAction, INITIAL_STATE);
  const errors = state.fieldErrors ?? {};
  const values = state.values ?? {};
  return (
    <form action={action} className="grid gap-5" noValidate>
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <Field name="name" label="Account name" error={errors["name"]}>
        {(props) => <Input {...props} required maxLength={60} autoComplete="off" placeholder="e.g. HDFC Savings" defaultValue={values["name"]} />}
      </Field>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field name="type" label="Type" error={errors["type"]}>
          {(props) => (
            <NativeSelect {...props} defaultValue={values["type"] ?? "bank"}>
              {TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field name="currency" label="Currency" error={errors["currency"]} hint="Cannot be changed later.">
          {(props) => (
            <NativeSelect {...props} defaultValue={values["currency"] ?? "INR"}>
              {currencies.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
      </div>
      <fieldset className="grid gap-4 rounded-lg border p-4">
        <legend className="px-1 text-sm font-medium">Opening balance (optional)</legend>
        <p className="text-xs text-muted-foreground">{OPENING_HINT}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field name="openingAmount" label="Amount" error={errors["openingAmount"]}>
            {(props) => <Input {...props} inputMode="decimal" autoComplete="off" placeholder="0.00" defaultValue={values["openingAmount"]} />}
          </Field>
          <Field name="openingDate" label="As of" error={errors["openingDate"]}>
            {(props) => <Input {...props} type="date" defaultValue={values["openingDate"] ?? today} />}
          </Field>
        </div>
      </fieldset>
      <FormError state={state} />
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create account"}
        </Button>
      </div>
    </form>
  );
}

export function EditAccountForm({ account }: { account: { id: string; name: string; type: string } }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(updateAccountAction, INITIAL_STATE);
  const errors = state.fieldErrors ?? {};
  const values = state.values ?? {};
  return (
    <form action={action} className="grid gap-4" noValidate>
      <input type="hidden" name="accountId" value={account.id} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field name="name" label="Account name" error={errors["name"]}>
          {(props) => <Input {...props} required maxLength={60} defaultValue={values["name"] ?? account.name} autoComplete="off" />}
        </Field>
        <Field name="type" label="Type" error={errors["type"]}>
          {(props) => (
            <NativeSelect {...props} defaultValue={values["type"] ?? account.type}>
              {TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
      </div>
      <FormError state={state} />
      <div>
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}

export function OpeningBalanceForm({
  accountId,
  idempotencyKey,
  today,
  mode,
  currencyCode,
}: {
  accountId: string;
  idempotencyKey: string;
  today: string;
  mode: "set" | "correct";
  currencyCode: string;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(setOpeningBalanceAction, INITIAL_STATE);
  const errors = state.fieldErrors ?? {};
  const values = state.values ?? {};
  return (
    <form action={action} className="grid gap-4" noValidate>
      <input type="hidden" name="accountId" value={accountId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="mode" value={mode} />
      <p className="text-xs text-muted-foreground">
        {mode === "correct"
          ? "Correcting reverses the current opening balance and records the new one. Both stay in the history."
          : OPENING_HINT}
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field name="openingAmount" label={`Opening balance (${currencyCode})`} error={errors["openingAmount"]}>
          {(props) => <Input {...props} inputMode="decimal" autoComplete="off" placeholder="0.00" required defaultValue={values["openingAmount"]} />}
        </Field>
        <Field name="openingDate" label="As of" error={errors["openingDate"]}>
          {(props) => <Input {...props} type="date" defaultValue={values["openingDate"] ?? today} />}
        </Field>
      </div>
      <FormError state={state} />
      <div>
        <Button type="submit" variant={mode === "correct" ? "outline" : "default"} disabled={pending}>
          {pending ? "Saving…" : mode === "correct" ? "Correct opening balance" : "Record opening balance"}
        </Button>
      </div>
    </form>
  );
}
