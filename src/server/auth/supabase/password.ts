import type { SupabaseClient } from "@supabase/supabase-js";

export type PasswordSignInResult = "signed-in" | "failed" | "rate-limited";

export async function signInWithEmailPassword(
  client: () => Promise<SupabaseClient>,
  email: string,
  password: string,
): Promise<PasswordSignInResult> {
  const supabase = await client();
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (error) return error.status === 429 ? "rate-limited" : "failed";
  return data.session ? "signed-in" : "failed";
}
