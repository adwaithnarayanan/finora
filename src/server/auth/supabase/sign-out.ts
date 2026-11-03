import type { SupabaseClient } from "@supabase/supabase-js";

export async function endSession(
  client: () => Promise<SupabaseClient>,
): Promise<void> {
  const supabase = await client();
  await supabase.auth.signOut({ scope: "local" });
}
