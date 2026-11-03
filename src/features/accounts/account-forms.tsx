"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { Field, FormError } from "../shared/field";
import { SelectField } from "../shared/select-field";
import { useFormAction } from "../shared/use-form-action";
import {
  createAccountAction,
  setOpeningBalanceAction,
  updateAccountAction,
} from "./actions";

const OPENING_HINT =
  "Your balance on this date when you start tracking. It is recorded as an opening balance (a starting position), not as income.";

const OWED_HINT =
  "What you owe on the card on this date when you start tracking. It is recorded as an opening balance owed, not as an expense. An opening credit balance in your favour is not supported yet.";

const ASSET_TYPES = [
  { value: "bank", label: "Bank account" },
  { value: "cash", label: "Cash" },
] as const;

const TYPES = [
  ...ASSET_TYPES,
  { value: "credit_card", label: "Credit card" },
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
  const { state, action, pending, errors, values } =
    useFormAction(createAccountAction);
  const [type, setType] = useState(values["type"] ?? "bank");
  const card = type === "credit_card";
  return (
    <form action={action} className="grid gap-5" noValidate>
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <Field name="name" label="Account name" error={errors["name"]}>
        {(props) => (
          <Input
            {...props}
            required
            maxLength={60}
            autoComplete="off"
            placeholder="e.g. HDFC Savings"
            defaultValue={values["name"]}
          />
        )}
      </Field>
      <div className="grid gap-5 sm:grid-cols-2">
        {/* Uncontrolled like the other fields; `type` only drives the labels. */}
        <SelectField
          name="type"
          label="Type"
          error={errors["type"]}
          options={TYPES}
          defaultValue={values["type"] ?? "bank"}
          remountKey={values["type"] ?? ""}
          onChange={setType}
        />
        <SelectField
          name="currency"
          label="Currency"
          hint="Cannot be changed later."
          error={errors["currency"]}
          options={currencies.map((c) => ({ value: c.code, label: c.label }))}
          defaultValue={values["currency"] ?? "INR"}
          remountKey={values["currency"] ?? ""}
        />
      </div>
      <fieldset className="grid gap-4 rounded-lg border p-4">
        <legend className="px-1 text-sm font-medium">
          Opening balance (optional)
        </legend>
        <p className="text-xs text-muted-foreground">
          {card ? OWED_HINT : OPENING_HINT}
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            name="openingAmount"
            label={card ? "Amount owed today" : "Amount"}
            error={errors["openingAmount"]}
          >
            {(props) => (
              <Input
                {...props}
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00"
                defaultValue={values["openingAmount"]}
              />
            )}
          </Field>
          <Field name="openingDate" label="As of" error={errors["openingDate"]}>
            {(props) => (
              <Input
                {...props}
                type="date"
                defaultValue={values["openingDate"] ?? today}
              />
            )}
          </Field>
        </div>
      </fieldset>
      <FormError state={state} />
      <div>
        <Button type="submit" loading={pending} loadingText="Creating…">
          Create account
        </Button>
      </div>
    </form>
  );
}

export function EditAccountForm({
  account,
}: {
  account: { id: string; name: string; type: string; typeLabel: string };
}) {
  const { state, action, pending, errors, values } =
    useFormAction(updateAccountAction);
  return (
    <form action={action} className="grid gap-4" noValidate>
      <input type="hidden" name="accountId" value={account.id} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field name="name" label="Account name" error={errors["name"]}>
          {(props) => (
            <Input
              {...props}
              required
              maxLength={60}
              defaultValue={values["name"] ?? account.name}
              autoComplete="off"
            />
          )}
        </Field>
        {account.type === "credit_card" ? (
          <div className="grid content-start gap-2 text-sm">
            <input type="hidden" name="type" value={account.type} />
            <span className="font-medium">Type</span>
            <span>{account.typeLabel}</span>
            <span className="text-xs text-muted-foreground">
              A credit card&apos;s type cannot be changed.
            </span>
          </div>
        ) : (
          <SelectField
            name="type"
            label="Type"
            error={errors["type"]}
            options={ASSET_TYPES}
            defaultValue={values["type"] ?? account.type}
          />
        )}
      </div>
      <FormError state={state} />
      <div>
        <Button
          type="submit"
          loading={pending}
          loadingText="Saving…"
          variant="outline"
        >
          Save changes
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
  owed,
}: {
  accountId: string;
  idempotencyKey: string;
  today: string;
  mode: "set" | "correct";
  currencyCode: string;
  owed: boolean;
}) {
  const { state, action, pending, errors, values } = useFormAction(
    setOpeningBalanceAction,
  );
  return (
    <form action={action} className="grid gap-4" noValidate>
      <input type="hidden" name="accountId" value={accountId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="mode" value={mode} />
      <p className="text-xs text-muted-foreground">
        {mode === "correct"
          ? "Correcting reverses the current opening balance and records the new one. Both stay in the history."
          : owed
            ? OWED_HINT
            : OPENING_HINT}
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          name="openingAmount"
          label={
            owed
              ? `Amount owed (${currencyCode})`
              : `Opening balance (${currencyCode})`
          }
          error={errors["openingAmount"]}
        >
          {(props) => (
            <Input
              {...props}
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              required
              defaultValue={values["openingAmount"]}
            />
          )}
        </Field>
        <Field name="openingDate" label="As of" error={errors["openingDate"]}>
          {(props) => (
            <Input
              {...props}
              type="date"
              defaultValue={values["openingDate"] ?? today}
            />
          )}
        </Field>
      </div>
      <FormError state={state} />
      <div>
        <Button
          type="submit"
          loading={pending}
          loadingText="Saving…"
          variant={mode === "correct" ? "outline" : "default"}
        >
          {mode === "correct"
            ? "Correct opening balance"
            : "Record opening balance"}
        </Button>
      </div>
    </form>
  );
}
