"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireOwner } from "@/server/auth/session";
import { finance } from "@/server/finance";

import { toActionStateOrFallback } from "../shared/errors";
import { runFormAction } from "../shared/form-action";
import type { ActionState } from "../shared/form-state";

export async function createCategoryAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runFormAction(formData, async (owner, input) => {
    await finance.createCategory(owner, {
      name: input["name"],
      kind: input["kind"],
    });
    revalidatePath("/categories");
    return { message: `Added ${input["name"]?.trim()}.` };
  });
}

export async function renameCategoryAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return runFormAction(formData, async (owner, input) => {
    await finance.renameCategory(owner, input["categoryId"] ?? "", {
      name: input["name"],
    });
    revalidatePath("/categories");
    return { message: "Renamed." };
  });
}

export async function initializeDefaultCategoriesAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const owner = await requireOwner();
  try {
    await finance.initializeDefaultCategories(owner);
  } catch (error) {
    return toActionStateOrFallback(
      error,
      "The default categories could not be added, so nothing was changed. Try again.",
    );
  }
  revalidatePath("/categories");
  revalidatePath("/transactions/new");
  // Outside the try: redirect() throws a control-flow exception.
  if (formData.get("returnTo") === "/transactions/new")
    redirect("/transactions/new");
  return { message: "Default categories added." };
}

export async function setCategoryArchivedAction(
  formData: FormData,
): Promise<void> {
  const owner = await requireOwner();
  await finance.setCategoryArchived(
    owner,
    String(formData.get("categoryId") ?? ""),
    formData.get("archived") === "true",
  );
  revalidatePath("/categories");
}
