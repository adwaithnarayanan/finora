"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";

import { Field, FormError } from "../shared/field";
import { type ActionState, INITIAL_STATE } from "../shared/form-state";
import { recordTransactionAction } from "./actions";

type Kind = "income" | "expense" | "transfer" | "card_payment" | "card_refund";
type Option = { id: string; label: string };
/**
 * `card`: a credit card. It can pay an expense, be paid by a card payment and
 * be credited by a card refund, and nothing else.
 */
type AccountOption = Option & { currencyCode: string; exponent: number; card: boolean };
/** A card purchase a refund can be linked to (see toRefundablePurchaseOptions). */
type PurchaseOption = Option & { cardAccountId: string; categoryLabel: string };

const KINDS: readonly { value: Kind; label: string; hint: string }[] = [
  { value: "expense", label: "Expense", hint: "Money spent from an account or on a credit card" },
  { value: "income", label: "Income", hint: "Money received into an account" },
  { value: "transfer", label: "Transfer", hint: "Moving money between your own accounts" },
  { value: "card_payment", label: "Card payment", hint: "Paying a credit card from a bank or cash account" },
  { value: "card_refund", label: "Card refund", hint: "Money a merchant gave back onto a credit card" },
];

/** The submit button's label; "Record card_payment" would read badly. */
const ACTION_LABEL: Record<Kind, string> = {
  expense: "Record expense",
  income: "Record income",
  transfer: "Record transfer",
  card_payment: "Record card payment",
  card_refund: "Record refund",
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
  initialPurchaseId,
  accounts,
  incomeCategories,
  expenseCategories,
  purchases,
}: {
  idempotencyKey: string;
  today: string;
  initialKind: Kind;
  /** Preselected "Paid from" / "From account" (e.g. from an account's page). */
  initialSourceAccountId?: string;
  /** Preselected "Card to pay" / "Refunded to" (from a card's page). */
  initialDestinationAccountId?: string;
  /** Preselected purchase being refunded (from that purchase's page). */
  initialPurchaseId?: string;
  accounts: readonly AccountOption[];
  incomeCategories: readonly Option[];
  expenseCategories: readonly Option[];
  /** Card purchases with something left to refund, for the linked-refund selector. */
  purchases: readonly PurchaseOption[];
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(recordTransactionAction, INITIAL_STATE);
  const values = state.values ?? {};
  const errors = state.fieldErrors ?? {};
  const [kind, setKind] = useState<Kind>((values["kind"] as Kind | undefined) ?? initialKind);
  const [source, setSource] = useState(values["sourceAccountId"] ?? initialSourceAccountId ?? "");
  const [destination, setDestination] = useState(values["destinationAccountId"] ?? initialDestinationAccountId ?? "");
  // A refund either refunds a purchase Finora recorded, or records a merchant
  // credit for one it never saw. Linked is the default: it is the better
  // record when the purchase is there, and it is what keeps the refund inside
  // what was actually paid. The mode is submitted, so a refused submission
  // comes back on the same mode (and so that choosing "a recorded purchase"
  // without picking one is reported on the purchase field).
  const [linkedRefund, setLinkedRefund] = useState((values["refundMode"] ?? "linked") !== "unlinked");
  const [purchase, setPurchase] = useState(values["refundsTransactionId"] ?? initialPurchaseId ?? "");
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
  const onCard = kind === "card_payment" || kind === "card_refund";
  const sources = kind === "expense" ? accounts : nonCards;
  const destinations = onCard ? cards : nonCards.filter((a) => kind !== "transfer" || a.id !== source);
  // Only the chosen card's purchases, so the selector never offers one the
  // server would refuse.
  const cardPurchases = purchases.filter((p) => p.cardAccountId === destination);
  const chosenPurchase = cardPurchases.find((p) => p.id === purchase);
  const changeKind = (next: Kind) => {
    setKind(next);
    // Drop a choice the next kind's list cannot offer, so no stale id is submitted.
    if (next !== "expense" && isCard(source)) setSource("");
    if (next === "card_payment" || next === "card_refund" ? !isCard(destination) : isCard(destination)) {
      setDestination("");
      setPurchase("");
    }
    // A transfer's destination list leaves out the source, so the browser drops that choice.
    else if (next === "transfer" && destination !== "" && destination === source) setDestination("");
  };
  // The purchases offered belong to one card, so changing the card clears a
  // selection the new card cannot offer.
  const changeDestination = (id: string) => {
    setDestination(id);
    if (!purchases.some((p) => p.id === purchase && p.cardAccountId === id)) setPurchase("");
  };
  // A transfer's destination list leaves out the source, so choosing it as the source clears it.
  const changeSource = (id: string) => {
    setSource(id);
    if (id === destination) setDestination("");
  };

  const accountId = kind === "income" || kind === "card_refund" ? destination : source;
  const currency = accounts.find((a) => a.id === accountId);
  const amountHint = currency
    ? `In ${currency.currencyCode}${currency.exponent > 0 ? `, up to ${currency.exponent} decimal places` : ", whole units"}.`
    : "Choose the account first.";

  return (
    <form action={action} className="grid gap-5" noValidate>
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">Type</legend>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
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
        {kind !== "income" && kind !== "card_refund" ? (
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
            label={
              kind === "transfer"
                ? "To account"
                : kind === "card_payment"
                  ? "Card to pay"
                  : kind === "card_refund"
                    ? "Refunded to"
                    : "Received into"
            }
            accounts={destinations}
            error={errors["destinationAccountId"]}
            hint={
              kind === "card_payment"
                ? "The payment reduces the amount owed on this card. It is not an expense."
                : kind === "card_refund"
                  ? "The refund reduces the amount owed on this card and reduces your expenses. It is not income."
                  : undefined
            }
            round={round}
            value={destination}
            onChange={changeDestination}
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
        {kind === "card_refund" ? (
          <>
            <fieldset className="grid gap-2 sm:col-span-2">
              <legend className="mb-1 text-sm font-medium">What is being refunded</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {[
                  { linked: true, label: "A purchase recorded in Finora", hint: "Pick it below; the refund goes back to its category" },
                  { linked: false, label: "A purchase not in Finora", hint: "A merchant credit; choose the expense category yourself" },
                ].map((mode) => (
                  <label
                    key={String(mode.linked)}
                    className="flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm has-checked:border-primary has-checked:bg-muted/60 has-focus-visible:ring-2 has-focus-visible:ring-ring"
                  >
                    <input
                      type="radio"
                      name="refundMode"
                      value={mode.linked ? "linked" : "unlinked"}
                      // Uncontrolled, like the kind radios: the reset after a
                      // submission restores the current mode from defaultChecked.
                      defaultChecked={linkedRefund === mode.linked}
                      onChange={() => {
                        setLinkedRefund(mode.linked);
                        // Leaving linked mode drops the purchase, so no stale
                        // id is submitted with an unlinked refund.
                        if (!mode.linked) setPurchase("");
                      }}
                      className="mt-0.5"
                    />
                    <span>
                      <span className="block font-medium">{mode.label}</span>
                      <span className="block text-xs text-muted-foreground">{mode.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            {linkedRefund ? (
              <Field
                name="refundsTransactionId"
                label="Purchase being refunded"
                hint={
                  destination === ""
                    ? "Choose the card first."
                    : cardPurchases.length === 0
                      ? "This card has no purchases left to refund. Record it as a purchase not in Finora instead."
                      : chosenPurchase
                        ? `The refund credits ${chosenPurchase.categoryLabel}, the category this purchase was charged to.`
                        : "Fully refunded and voided purchases are not listed."
                }
                error={errors["refundsTransactionId"]}
              >
                {(props) => (
                  // Keyed on `round` so a refused submission remounts it with
                  // what was submitted (a select applies defaultValue on mount only).
                  <NativeSelect
                    {...props}
                    key={round}
                    defaultValue={purchase}
                    onChange={(e) => setPurchase(e.target.value)}
                    required
                  >
                    <option value="">Choose a purchase</option>
                    {cardPurchases.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
            ) : (
              <Field
                name="refundCategoryId"
                label="Category being refunded"
                hint="The expense category the original purchase belonged to. The refund reduces that category's expenses."
                error={errors["refundCategoryId"]}
              >
                {(props) => (
                  <NativeSelect {...props} key={values["refundCategoryId"] ?? ""} defaultValue={values["refundCategoryId"] ?? ""} required>
                    <option value="">Choose a category</option>
                    {expenseCategories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
            )}
          </>
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
        {kind === "income" || kind === "expense" || kind === "card_refund" ? (
          <Field
            name="payee"
            label={kind === "expense" ? "Paid to (optional)" : kind === "card_refund" ? "Refunded by (optional)" : "Received from (optional)"}
            error={errors["payee"]}
          >
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
