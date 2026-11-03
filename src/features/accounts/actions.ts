"use server";

import { redirect } from "next/navigation";

import { requireOwner } from "@/server/auth/session";
import { finance } from "@/server/finance";

import { runFormAction } from "../shared/form-action";
import type { ActionState } from "../shared/form-state";

/** Creates an account (and its opening balance, if given) atomically. */
export async function createAccountAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runFormAction(formData, async (owner, input) => {
    const { value } = await finance.createAccount(owner, {
      name: input["name"],
      type: input["type"],
      currency: input["currency"],
      openingBalance: input["openingAmount"]?.trim()
        ? { amount: input["openingAmount"], date: input["openingDate"] }
        : null,
      idempotencyKey: input["idempotencyKey"],
    });
    return { redirectTo: `/accounts/${value.id}` };
  });
}

export async function updateAccountAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runFormAction(formData, async (owner, input) => {
    await finance.updateAccount(owner, input["accountId"] ?? "", { name: input["name"], type: input["type"] });
    return { message: "Saved." };
  });
}

export async function setOpeningBalanceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runFormAction(formData, async (owner, input) => {
    const accountId = input["accountId"] ?? "";
    const request = { amount: input["openingAmount"] ?? "", date: input["openingDate"], idempotencyKey: input["idempotencyKey"] };
    if (input["mode"] === "correct") await finance.correctOpeningBalance(owner, accountId, request);
    else await finance.setOpeningBalance(owner, accountId, request);
    return { redirectTo: `/accounts/${accountId}` };
  });
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
