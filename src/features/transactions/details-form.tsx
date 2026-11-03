"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

import { Field, FormError } from "../shared/field";
import { useFormAction } from "../shared/use-form-action";
import { updateTransactionDetailsAction } from "./actions";

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
  const { state, action, pending, errors, values } = useFormAction(
    updateTransactionDetailsAction,
  );
  return (
    <form action={action} className="grid gap-4" noValidate>
      <input type="hidden" name="transactionId" value={transactionId} />
      {allowPayee ? (
        <Field name="payee" label="Payee" error={errors["payee"]}>
          {(props) => (
            <Input
              {...props}
              maxLength={100}
              defaultValue={values["payee"] ?? payee ?? ""}
            />
          )}
        </Field>
      ) : null}
      <Field name="note" label="Note" error={errors["note"]}>
        {(props) => (
          <Textarea
            {...props}
            maxLength={500}
            rows={2}
            defaultValue={values["note"] ?? note ?? ""}
          />
        )}
      </Field>
      <FormError state={state} />
      <div>
        <Button
          type="submit"
          loading={pending}
          loadingText="Saving…"
          variant="outline"
        >
          Save details
        </Button>
      </div>
    </form>
  );
}
