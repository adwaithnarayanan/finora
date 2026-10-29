"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";

import { Field, FormError } from "../shared/field";
import { type ActionState, INITIAL_STATE } from "../shared/form-state";
import { recordTransactionAction } from "./actions";

type Kind = "income" | "expense" | "transfer" | "card_payment";
type Option = { id: string; label: string };
/** `card`: a credit card. It can pay an expense or be paid by a card payment, and nothing else. */
type AccountOption = Option & { currencyCode: string; exponent: number; card: boolean };

const KINDS: readonly { value: Kind; label: string; hint: string }[] = [
  { value: "expense", label: "Expense", hint: "Money spent from an account or on a credit card" },
  { value: "income", label: "Income", hint: "Money received into an account" },
  { value: "transfer", label: "Transfer", hint: "Moving money between your own accounts" },
  { value: "card_payment", label: "Card payment", hint: "Paying a credit card from a bank or cash account" },
];

/** The submit button's label; "Record card_payment" would read badly. */
const ACTION_LABEL: Record<Kind, string> = {
  expense: "Record expense",
  income: "Record income",
  transfer: "Record transfer",
  card_payment: "Record card payment",
};

function AccountSelect({
  name,
  label,
  accounts,
  error,
  hint,
  round,
  value,
  onChange,
}: {
  name: string;
  label: string;
  accounts: readonly AccountOption[];
  error: string | undefined;
  hint?: string;
  /** Changes with every action result, so the select remounts showing `value`. */
  round: number;
  /** The current choice, mirrored by `onChange`; applied when the select mounts. */
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <Field name={name} label={label} hint={hint} error={error}>
      {(props) => (
        // Uncontrolled: the form is reset after every submission, and a reset
        // restores each select to its default, which React sets from
        // defaultValue on mount only (a controlled value is not kept). Keyed on
        // `round` so a refused submission remounts it with what was submitted.
        <NativeSelect {...props} key={round} defaultValue={value} onChange={(e) => onChange(e.target.value)} required>
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
  initialSourceAccountId,
  initialDestinationAccountId,
  accounts,
  incomeCategories,
  expenseCategories,
}: {
  idempotencyKey: string;
  today: string;
  initialKind: Kind;
  /** Preselected "Paid from" / "From account" (e.g. from an account's page). */
  initialSourceAccountId?: string;
  /** Preselected "Card to pay" (from a card's page). */
  initialDestinationAccountId?: string;
  accounts: readonly AccountOption[];
  incomeCategories: readonly Option[];
  expenseCategories: readonly Option[];
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(recordTransactionAction, INITIAL_STATE);
  const values = state.values ?? {};
  const errors = state.fieldErrors ?? {};
  const [kind, setKind] = useState<Kind>((values["kind"] as Kind | undefined) ?? initialKind);
  const [source, setSource] = useState(values["sourceAccountId"] ?? initialSourceAccountId ?? "");
  const [destination, setDestination] = useState(values["destinationAccountId"] ?? initialDestinationAccountId ?? "");
  // Counts action results (each a refused submission; success redirects).
  const [result, setResult] = useState(state);
  const [round, setRound] = useState(0);
  if (result !== state) {
    setResult(state);
    setRound(round + 1);
  }

  // A card may only pay an expense or be paid by a card payment: every other
  // picker lists bank and cash accounts only.
  const nonCards = accounts.filter((a) => !a.card);
  const cards = accounts.filter((a) => a.card);
  const isCard = (id: string) => accounts.find((a) => a.id === id)?.card === true;
  const sources = kind === "expense" ? accounts : nonCards;
  const destinations = kind === "card_payment" ? cards : nonCards.filter((a) => kind !== "transfer" || a.id !== source);
  const changeKind = (next: Kind) => {
    setKind(next);
    // Drop a choice the next kind's list cannot offer, so no stale id is submitted.
    if (next !== "expense" && isCard(source)) setSource("");
    if (next === "card_payment" ? !isCard(destination) : isCard(destination)) setDestination("");
    // A transfer's destination list leaves out the source, so the browser drops that choice.
    else if (next === "transfer" && destination !== "" && destination === source) setDestination("");
  };
  // A transfer's destination list leaves out the source, so choosing it as the source clears it.
  const changeSource = (id: string) => {
    setSource(id);
    if (id === destination) setDestination("");
  };

  const accountId = kind === "income" ? destination : source;
  const currency = accounts.find((a) => a.id === accountId);
  const amountHint = currency
    ? `In ${currency.currencyCode}${currency.exponent > 0 ? `, up to ${currency.exponent} decimal places` : ", whole units"}.`
    : "Choose the account first.";

  return (
    <form action={action} className="grid gap-5" noValidate>
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">Type</legend>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {KINDS.map((k) => (
            <label
              key={k.value}
              className="flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm has-checked:border-primary has-checked:bg-muted/60 has-focus-visible:ring-2 has-focus-visible:ring-ring"
            >
              <input
                type="radio"
                name="kind"
                value={k.value}
                // Uncontrolled, so the reset after a submission restores the
                // current kind: React keeps defaultChecked up to date.
                defaultChecked={kind === k.value}
                onChange={() => changeKind(k.value)}
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
            accounts={sources}
            error={errors["sourceAccountId"]}
            hint={
              kind === "expense" && currency?.card
                ? "Paid by credit card: adds to the amount owed on the card."
                : kind === "card_payment"
                  ? "The bank or cash account the money comes from."
                  : undefined
            }
            round={round}
            value={source}
            onChange={changeSource}
          />
        ) : null}
        {kind !== "expense" ? (
          <AccountSelect
            name="destinationAccountId"
            label={kind === "transfer" ? "To account" : kind === "card_payment" ? "Card to pay" : "Received into"}
            accounts={destinations}
            error={errors["destinationAccountId"]}
            hint={kind === "card_payment" ? "The payment reduces the amount owed on this card. It is not an expense." : undefined}
            round={round}
            value={destination}
            onChange={setDestination}
          />
        ) : null}
        {kind === "income" ? (
          <Field name="incomeCategoryId" label="Category" error={errors["incomeCategoryId"]}>
            {(props) => (
              // Keyed on the submitted value: a select applies defaultValue only on
              // mount, and the form is reset after every submission.
              <NativeSelect {...props} key={values["incomeCategoryId"] ?? ""} defaultValue={values["incomeCategoryId"] ?? ""} required>
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
              // Keyed on the submitted value: a select applies defaultValue only on
              // mount, and the form is reset after every submission.
              <NativeSelect {...props} key={values["expenseCategoryId"] ?? ""} defaultValue={values["expenseCategoryId"] ?? ""} required>
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
        {kind === "income" || kind === "expense" ? (
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
          {pending ? "Saving…" : ACTION_LABEL[kind]}
        </Button>
      </div>
    </form>
  );
}
