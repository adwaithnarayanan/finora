"use server";

import { redirect } from "next/navigation";

import { requireOwner } from "@/server/auth/session";
import { finance } from "@/server/finance";

import { toActionState } from "../shared/errors";
import { type ActionState, formEntries } from "../shared/form-state";

/** Creates an account (and its opening balance, if given) atomically. */
export async function createAccountAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const owner = await requireOwner();
  const input = formEntries(formData);
  let accountId: string;
  try {
    const { value } = await finance.createAccount(owner, {
      name: input["name"],
      type: input["type"],
      currency: input["currency"],
      openingBalance: input["openingAmount"]?.trim()
        ? { amount: input["openingAmount"], date: input["openingDate"] }
        : null,
      idempotencyKey: input["idempotencyKey"],
    });
    accountId = value.id;
  } catch (error) {
    return { ...toActionState(error), values: input };
  }
  redirect(`/accounts/${accountId}`);
}

export async function updateAccountAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const owner = await requireOwner();
  const input = formEntries(formData);
  try {
    await finance.updateAccount(owner, input["accountId"] ?? "", { name: input["name"], type: input["type"] });
  } catch (error) {
    return { ...toActionState(error), values: input };
  }
  return { message: "Saved." };
}

export async function setOpeningBalanceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const owner = await requireOwner();
  const input = formEntries(formData);
  const accountId = input["accountId"] ?? "";
  try {
    const request = { amount: input["openingAmount"] ?? "", date: input["openingDate"], idempotencyKey: input["idempotencyKey"] };
    if (input["mode"] === "correct") await finance.correctOpeningBalance(owner, accountId, request);
    else await finance.setOpeningBalance(owner, accountId, request);
  } catch (error) {
    return { ...toActionState(error), values: input };
  }
  redirect(`/accounts/${accountId}`);
}

async function lifecycle(formData: FormData, change: "archive" | "restore" | "delete"): Promise<void> {
  const owner = await requireOwner();
  const id = String(formData.get("accountId") ?? "");
  if (change === "archive") await finance.archiveAccount(owner, id);
  if (change === "restore") await finance.restoreAccount(owner, id);
  if (change === "delete") {
    await finance.deleteAccount(owner, id);
    redirect("/accounts");
  }
  redirect(`/accounts/${id}`);
}

export async function archiveAccountAction(formData: FormData): Promise<void> {
  await lifecycle(formData, "archive");
}

export async function restoreAccountAction(formData: FormData): Promise<void> {
  await lifecycle(formData, "restore");
}

export async function deleteAccountAction(formData: FormData): Promise<void> {
  await lifecycle(formData, "delete");
}
