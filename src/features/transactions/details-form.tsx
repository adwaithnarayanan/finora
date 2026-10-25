"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

import { Field, FormError } from "../shared/field";
import { type ActionState, INITIAL_STATE } from "../shared/form-state";
import { updateTransactionDetailsAction } from "./actions";

/** Edits metadata only (payee, note); amounts, dates and accounts are fixed once posted. */
export function TransactionDetailsForm({
  transactionId,
  payee,
  note,
  allowPayee,
}: {
  transactionId: string;
  payee: string | null;
  note: string | null;
  allowPayee: boolean;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(updateTransactionDetailsAction, INITIAL_STATE);
  const values = state.values ?? {};
  const errors = state.fieldErrors ?? {};
  return (
    <form action={action} className="grid gap-4" noValidate>
      <input type="hidden" name="transactionId" value={transactionId} />
      {allowPayee ? (
        <Field name="payee" label="Payee" error={errors["payee"]}>
          {(props) => <Input {...props} maxLength={100} defaultValue={values["payee"] ?? payee ?? ""} />}
        </Field>
      ) : null}
      <Field name="note" label="Note" error={errors["note"]}>
        {(props) => <Textarea {...props} maxLength={500} rows={2} defaultValue={values["note"] ?? note ?? ""} />}
      </Field>
      <FormError state={state} />
      <div>
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? "Saving…" : "Save details"}
        </Button>
      </div>
    </form>
  );
}
