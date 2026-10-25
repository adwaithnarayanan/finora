import type { SupabaseClient } from "@supabase/supabase-js";

export type PasswordSignInResult = "signed-in" | "failed" | "rate-limited";

/**
 * Email/password sign-in through Supabase Auth. Every refusal (wrong
 * password, unknown email, unverified email, passwordless user, disabled
 * provider) collapses to "failed" so callers cannot reveal which one it was;
 * only rate limiting, which applies to everyone alike, is distinguished.
 */
export async function signInWithEmailPassword(
  client: () => Promise<SupabaseClient>,
  email: string,
  password: string,
): Promise<PasswordSignInResult> {
  const supabase = await client();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return error.status === 429 ? "rate-limited" : "failed";
  return data.session ? "signed-in" : "failed";
}
