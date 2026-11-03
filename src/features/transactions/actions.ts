"use server";

import { redirect } from "next/navigation";

import { requireOwner } from "@/server/auth/session";
import { finance } from "@/server/finance";

import { runFormAction } from "../shared/form-action";
import { type ActionState, formEntries } from "../shared/form-state";

/** The form has one category select per kind; a refund's is only for an unlinked one. */
const categoryField = (kind: string | undefined) =>
  kind === "income" ? "incomeCategoryId" : kind === "card_refund" ? "refundCategoryId" : "expenseCategoryId";

/**
 * Records an income, expense, transfer, card payment or card refund from the
 * submitted intent. The server resolves every reference under the authorised
 * owner and builds the journal lines from its own templates; no lines are
 * accepted from the form.
 */
export async function recordTransactionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runFormAction(
    formData,
    async (owner, input) => {
      const { value } = await finance.recordTransaction(owner, {
        kind: input["kind"],
        amount: input["amount"] ?? "",
        date: input["date"],
        sourceAccountId: input["sourceAccountId"],
        destinationAccountId: input["destinationAccountId"],
        categoryId: input[categoryField(input["kind"])],
        refundsTransactionId: input["refundsTransactionId"],
        refundMode: input["refundMode"],
        payee: input["payee"],
        note: input["note"],
        idempotencyKey: input["idempotencyKey"],
      });
      return { redirectTo: `/transactions?recorded=${value.id}` };
    },
    (state, input) => {
      // The service reports `categoryId`; show it on the select for this kind.
      const categoryError = state.fieldErrors?.["categoryId"];
      if (!state.fieldErrors || !categoryError) return state;
      return { ...state, fieldErrors: { ...state.fieldErrors, [categoryField(input["kind"])]: categoryError } };
    },
  );
}

export async function updateTransactionDetailsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runFormAction(formData, async (owner, input) => {
    await finance.updateTransactionDetails(owner, input["transactionId"] ?? "", { payee: input["payee"], note: input["note"] });
    return { message: "Saved." };
  });
}

/** Voids through a ledger reversal (the original stays in history). */
export async function voidTransactionAction(formData: FormData): Promise<void> {
  const owner = await requireOwner();
  const input = formEntries(formData);
  const id = input["transactionId"] ?? "";
  await finance.voidTransaction(owner, id, { date: input["date"], idempotencyKey: input["idempotencyKey"] });
  redirect(`/transactions/${id}`);
}
