"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";

import { Field, FormError } from "../shared/field";
import { type ActionState, INITIAL_STATE } from "../shared/form-state";
import { recordTransactionAction } from "./actions";

type Kind = "income" | "expense" | "transfer";
type Option = { id: string; label: string };
type AccountOption = Option & { currencyCode: string; exponent: number };

const KINDS: readonly { value: Kind; label: string; hint: string }[] = [
  { value: "expense", label: "Expense", hint: "Money spent from an account" },
  { value: "income", label: "Income", hint: "Money received into an account" },
  { value: "transfer", label: "Transfer", hint: "Moving money between your own accounts" },
];

function AccountSelect({
  name,
  label,
  accounts,
  error,
  value,
  onChange,
}: {
  name: string;
  label: string;
  accounts: readonly AccountOption[];
  error: string | undefined;
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <Field name={name} label={label} error={error}>
      {(props) => (
        <NativeSelect {...props} value={value} onChange={(e) => onChange(e.target.value)} required>
          <option value="">Choose an account</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </NativeSelect>
      )}
    </Field>
  );
}

export function TransactionForm({
  idempotencyKey,
  today,
  initialKind,
  accounts,
  incomeCategories,
  expenseCategories,
}: {
  idempotencyKey: string;
  today: string;
  initialKind: Kind;
  accounts: readonly AccountOption[];
  incomeCategories: readonly Option[];
  expenseCategories: readonly Option[];
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(recordTransactionAction, INITIAL_STATE);
  const values = state.values ?? {};
  const errors = state.fieldErrors ?? {};
  const [kind, setKind] = useState<Kind>((values["kind"] as Kind | undefined) ?? initialKind);
  const [source, setSource] = useState(values["sourceAccountId"] ?? "");
  const [destination, setDestination] = useState(values["destinationAccountId"] ?? "");

  const assetId = kind === "income" ? destination : source;
  const currency = accounts.find((a) => a.id === assetId);
  const amountHint = currency
    ? `In ${currency.currencyCode}${currency.exponent > 0 ? `, up to ${currency.exponent} decimal places` : ", whole units"}.`
    : "Choose the account first.";

  return (
    <form action={action} className="grid gap-5" noValidate>
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">Type</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {KINDS.map((k) => (
            <label
              key={k.value}
              className="flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm has-checked:border-primary has-checked:bg-muted/60 has-focus-visible:ring-2 has-focus-visible:ring-ring"
            >
              <input
                type="radio"
                name="kind"
                value={k.value}
                checked={kind === k.value}
                onChange={() => setKind(k.value)}
                className="mt-0.5"
              />
              <span>
                <span className="block font-medium">{k.label}</span>
                <span className="block text-xs text-muted-foreground">{k.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-5 sm:grid-cols-2">
        {kind !== "income" ? (
          <AccountSelect
            name="sourceAccountId"
            label={kind === "transfer" ? "From account" : "Paid from"}
            accounts={accounts}
            error={errors["sourceAccountId"]}
            value={source}
            onChange={setSource}
          />
        ) : null}
        {kind !== "expense" ? (
          <AccountSelect
            name="destinationAccountId"
            label={kind === "transfer" ? "To account" : "Received into"}
            accounts={kind === "transfer" ? accounts.filter((a) => a.id !== source) : accounts}
            error={errors["destinationAccountId"]}
            value={destination}
            onChange={setDestination}
          />
        ) : null}
        {kind === "income" ? (
          <Field name="incomeCategoryId" label="Category" error={errors["incomeCategoryId"]}>
            {(props) => (
              <NativeSelect {...props} defaultValue={values["incomeCategoryId"] ?? ""} required>
                <option value="">Choose a category</option>
                {incomeCategories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
        ) : null}
        {kind === "expense" ? (
          <Field name="expenseCategoryId" label="Category" error={errors["expenseCategoryId"]}>
            {(props) => (
              <NativeSelect {...props} defaultValue={values["expenseCategoryId"] ?? ""} required>
                <option value="">Choose a category</option>
                {expenseCategories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
        ) : null}
        <Field name="amount" label="Amount" hint={amountHint} error={errors["amount"]}>
          {(props) => (
            <Input {...props} inputMode="decimal" autoComplete="off" placeholder="0.00" defaultValue={values["amount"]} required />
          )}
        </Field>
        <Field name="date" label="Date" error={errors["date"]}>
          {(props) => <Input {...props} type="date" defaultValue={values["date"] ?? today} required />}
        </Field>
        {kind !== "transfer" ? (
          <Field name="payee" label={kind === "income" ? "Received from (optional)" : "Paid to (optional)"} error={errors["payee"]}>
            {(props) => <Input {...props} maxLength={100} autoComplete="off" defaultValue={values["payee"]} />}
          </Field>
        ) : null}
      </div>
      <Field name="note" label="Note (optional)" error={errors["note"]}>
        {(props) => <Textarea {...props} maxLength={500} rows={2} defaultValue={values["note"]} />}
      </Field>
      <FormError state={state} />
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : `Record ${kind}`}
        </Button>
      </div>
    </form>
  );
}
