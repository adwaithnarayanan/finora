"use server";

import { redirect } from "next/navigation";

import { authorizeOwner } from "@/server/auth/authorize";
import { safeNextPath } from "@/server/auth/redirect";
import { SupabaseIdentityProvider } from "@/server/auth/supabase/identity";
import { signInWithEmailPassword } from "@/server/auth/supabase/password";
import { createSupabaseServerClient } from "@/server/auth/supabase/server-client";
import { endSession } from "@/server/auth/supabase/sign-out";
import { getOwnerDirectory } from "@/server/db";

import { type ActionState, formEntries } from "../shared/form-state";
import { signInSchema } from "./schemas";

/** One message for every failure, so responses never reveal which accounts exist. */
const INVALID_CREDENTIALS = "Invalid email or password.";
const RATE_LIMITED = "Too many attempts. Wait a few minutes and try again.";

/**
 * Email/password sign-in (the current method, ADR 0003). A correct password
 * only creates a session; access additionally needs the operator's approval
 * and an owner mapping. Anyone else is signed out again immediately.
 */
export async function signIn(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = signInSchema.safeParse(formEntries(formData));
  if (!parsed.success) return { error: INVALID_CREDENTIALS };
  const { email, password, next } = parsed.data;

  const supabase = await createSupabaseServerClient();
  const result = await signInWithEmailPassword(async () => supabase, email, password);
  // Wrong password, unknown email and unverified email all look the same.
  if (result === "rate-limited") return { error: RATE_LIMITED };
  if (result === "failed") return { error: INVALID_CREDENTIALS };

  const access = await authorizeOwner({
    identities: new SupabaseIdentityProvider(async () => supabase),
    owners: getOwnerDirectory(),
  });
  if (access.status !== "authorized") {
    await endSession(async () => supabase);
    redirect("/unauthorized");
  }
  redirect(safeNextPath(next));
}

export async function signOut(): Promise<void> {
  await endSession(createSupabaseServerClient);
  redirect("/login");
}
