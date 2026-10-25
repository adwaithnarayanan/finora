"use server";

import { redirect } from "next/navigation";

import { authorizeOwner } from "@/server/auth/authorize";
import { safeNextPath } from "@/server/auth/redirect";
import { SupabaseIdentityProvider } from "@/server/auth/supabase/identity";
import { createSupabaseServerClient } from "@/server/auth/supabase/server-client";
import { getOwnerDirectory } from "@/server/db";
import { getSiteEnv } from "@/server/env";

import {
  type FormState,
  emailLinkSchema,
  formEntries,
  newPasswordSchema,
  resetRequestSchema,
  signInSchema,
} from "./schemas";

const INVALID_CREDENTIALS = "Invalid email or password.";
const RATE_LIMITED = "Too many attempts. Wait a few minutes and try again.";
const RESET_SENT =
  "If that address belongs to Finora's owner, a reset link is on its way. Check your inbox.";

export async function signIn(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = signInSchema.safeParse(formEntries(formData));
  if (!parsed.success) return { error: INVALID_CREDENTIALS };
  const { email, password, next } = parsed.data;

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    // One message for every credential failure (wrong password, unknown or
    // unconfirmed email) so responses do not reveal which accounts exist.
    return { error: error.status === 429 ? RATE_LIMITED : INVALID_CREDENTIALS };
  }

  const access = await authorizeOwner({
    identities: new SupabaseIdentityProvider(async () => supabase),
    owners: getOwnerDirectory(),
  });
  if (access.status !== "authorized") {
    // Valid credentials but not the configured owner: drop the session.
    await supabase.auth.signOut({ scope: "local" });
    redirect("/unauthorized");
  }
  redirect(safeNextPath(next));
}

export async function signOut(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut({ scope: "local" });
  redirect("/login");
}

export async function requestPasswordReset(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = resetRequestSchema.safeParse(formEntries(formData));
  if (!parsed.success) return { error: "Enter a valid email address." };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: new URL("/auth/confirm", getSiteEnv().NEXT_PUBLIC_SITE_URL).toString(),
  });
  // Same answer whether or not the address exists; only rate limiting is
  // surfaced, and it applies to every address alike.
  if (error?.status === 429) return { error: RATE_LIMITED };
  return { message: RESET_SENT };
}

/**
 * Completes an emailed recovery/invite link. Verification happens on an
 * explicit POST (not on GET) so link scanners cannot consume the token.
 */
export async function confirmEmailLink(formData: FormData): Promise<void> {
  const parsed = emailLinkSchema.safeParse(formEntries(formData));
  if (!parsed.success) redirect("/login?error=link");
  const { token_hash, type, next } = parsed.data;

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.verifyOtp({ token_hash, type });
  if (error) redirect("/login?error=link");
  redirect(safeNextPath(next, "/reset-password"));
}

export async function updatePassword(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const supabase = await createSupabaseServerClient();
  const identity = await new SupabaseIdentityProvider(async () => supabase).getVerifiedIdentity();
  if (!identity) redirect("/forgot-password");

  const parsed = newPasswordSchema.safeParse(formEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Choose a stronger password." };
  }

  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) {
    if (error.code === "same_password") return { error: "Choose a password you have not used here." };
    if (error.code === "weak_password") return { error: "Choose a stronger password." };
    if (error.code === "reauthentication_needed") {
      return { error: "This link has expired. Request a new reset email." };
    }
    return { error: "Could not update the password. Request a new reset email." };
  }
  // End every other session that may have been using the old password.
  await supabase.auth.signOut({ scope: "others" });
  redirect("/");
}
