"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireOwner } from "@/server/auth/session";
import { finance } from "@/server/finance";

import { toActionState, toActionStateOrFallback } from "../shared/errors";
import { type ActionState, formEntries } from "../shared/form-state";

export async function createCategoryAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const owner = await requireOwner();
  const input = formEntries(formData);
  try {
    await finance.createCategory(owner, { name: input["name"], kind: input["kind"] });
  } catch (error) {
    return { ...toActionState(error), values: input };
  }
  revalidatePath("/categories");
  return { message: `Added ${input["name"]?.trim()}.` };
}

export async function renameCategoryAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const owner = await requireOwner();
  const input = formEntries(formData);
  try {
    await finance.renameCategory(owner, input["categoryId"] ?? "", { name: input["name"] });
  } catch (error) {
    return { ...toActionState(error), values: input };
  }
  revalidatePath("/categories");
  return { message: "Renamed." };
}

/**
 * Explicit setup of the default categories for the signed-in owner (a POST
 * from a button; never run while rendering a page). Idempotent. A failure is
 * shown next to the button without internal detail; it changes nothing,
 * because the setup is one transaction.
 */
export async function initializeDefaultCategoriesAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const owner = await requireOwner();
  try {
    await finance.initializeDefaultCategories(owner);
  } catch (error) {
    return toActionStateOrFallback(error, "The default categories could not be added, so nothing was changed. Try again.");
  }
  revalidatePath("/categories");
  revalidatePath("/transactions/new");
  // Outside the try: redirect() throws a control-flow exception.
  if (formData.get("returnTo") === "/transactions/new") redirect("/transactions/new");
  return { message: "Default categories added." };
}

export async function setCategoryArchivedAction(formData: FormData): Promise<void> {
  const owner = await requireOwner();
  await finance.setCategoryArchived(owner, String(formData.get("categoryId") ?? ""), formData.get("archived") === "true");
  revalidatePath("/categories");
}
