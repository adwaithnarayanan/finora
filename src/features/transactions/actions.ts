"use server";

import { redirect } from "next/navigation";

import { requireOwner } from "@/server/auth/session";
import { finance } from "@/server/finance";

import { runFormAction } from "../shared/form-action";
import { type ActionState, formEntries } from "../shared/form-state";

const categoryField = (kind: string | undefined) =>
  kind === "income"
    ? "incomeCategoryId"
    : kind === "card_refund"
      ? "refundCategoryId"
      : "expenseCategoryId";

export async function recordTransactionAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
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
      const categoryError = state.fieldErrors?.["categoryId"];
      if (!state.fieldErrors || !categoryError) return state;
      return {
        ...state,
        fieldErrors: {
          ...state.fieldErrors,
          [categoryField(input["kind"])]: categoryError,
        },
      };
    },
  );
}

export async function updateTransactionDetailsAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runFormAction(formData, async (owner, input) => {
    await finance.updateTransactionDetails(
      owner,
      input["transactionId"] ?? "",
      { payee: input["payee"], note: input["note"] },
    );
    return { message: "Saved." };
  });
}

export async function voidTransactionAction(formData: FormData): Promise<void> {
  const owner = await requireOwner();
  const input = formEntries(formData);
  const id = input["transactionId"] ?? "";
  await finance.voidTransaction(owner, id, {
    date: input["date"],
    idempotencyKey: input["idempotencyKey"],
  });
  redirect(`/transactions/${id}`);
}
