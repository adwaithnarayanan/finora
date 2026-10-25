"use server";

import { redirect } from "next/navigation";

import { requireOwner } from "@/server/auth/session";
import { finance } from "@/server/finance";

import { toActionState } from "../shared/errors";
import { type ActionState, formEntries } from "../shared/form-state";

/**
 * Records an income, expense or transfer from the submitted intent. The
 * server resolves every reference under the authorised owner and builds the
 * journal lines from its own templates; no lines are accepted from the form.
 */
export async function recordTransactionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const owner = await requireOwner();
  const input = formEntries(formData);
  let id: string;
  try {
    const { value } = await finance.recordTransaction(owner, {
      kind: input["kind"],
      amount: input["amount"] ?? "",
      date: input["date"],
      sourceAccountId: input["sourceAccountId"],
      destinationAccountId: input["destinationAccountId"],
      categoryId: input["kind"] === "income" ? input["incomeCategoryId"] : input["expenseCategoryId"],
      payee: input["payee"],
      note: input["note"],
      idempotencyKey: input["idempotencyKey"],
    });
    id = value.id;
  } catch (error) {
    const state = toActionState(error);
    const fieldErrors = state.fieldErrors && {
      ...state.fieldErrors,
      // The form has one category select per kind.
      ...(state.fieldErrors["categoryId"]
        ? { [input["kind"] === "income" ? "incomeCategoryId" : "expenseCategoryId"]: state.fieldErrors["categoryId"] }
        : {}),
    };
    return { ...state, ...(fieldErrors ? { fieldErrors } : {}), values: input };
  }
  redirect(`/transactions?recorded=${id}`);
}

export async function updateTransactionDetailsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const owner = await requireOwner();
  const input = formEntries(formData);
  try {
    await finance.updateTransactionDetails(owner, input["transactionId"] ?? "", { payee: input["payee"], note: input["note"] });
  } catch (error) {
    return { ...toActionState(error), values: input };
  }
  return { message: "Saved." };
}

/** Voids through a ledger reversal (the original stays in history). */
export async function voidTransactionAction(formData: FormData): Promise<void> {
  const owner = await requireOwner();
  const input = formEntries(formData);
  const id = input["transactionId"] ?? "";
  await finance.voidTransaction(owner, id, { date: input["date"], idempotencyKey: input["idempotencyKey"] });
  redirect(`/transactions/${id}`);
}
