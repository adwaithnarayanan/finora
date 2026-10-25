"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { NEXT_PATH_COOKIE, NEXT_PATH_COOKIE_MAX_AGE } from "@/server/auth/callback";
import { safeNextPath } from "@/server/auth/redirect";
import { OAUTH_CALLBACK_PATH, startGoogleSignIn } from "@/server/auth/supabase/oauth";
import { createSupabaseServerClient } from "@/server/auth/supabase/server-client";
import { ACTIVE_SIGN_IN_METHOD } from "@/server/auth/supabase/sign-in-method";
import { getSiteEnv } from "@/server/env";

/**
 * DEFERRED: Google sign-in (ADR 0003). Not rendered anywhere while email and
 * password is the active method, and refuses to run if it is ever invoked.
 * The post-login path travels in an httpOnly cookie scoped to the callback.
 */
export async function signInWithGoogle(formData: FormData): Promise<void> {
  if (ACTIVE_SIGN_IN_METHOD !== "google") redirect("/login");
  const next = safeNextPath(formData.get("next"));
  const url = await startGoogleSignIn(createSupabaseServerClient);
  if (!url) redirect("/login?error=oauth");

  (await cookies()).set(NEXT_PATH_COOKIE, next, {
    httpOnly: true,
    sameSite: "lax",
    secure: new URL(getSiteEnv().NEXT_PUBLIC_SITE_URL).protocol === "https:",
    path: OAUTH_CALLBACK_PATH,
    maxAge: NEXT_PATH_COOKIE_MAX_AGE,
  });
  redirect(url);
}
