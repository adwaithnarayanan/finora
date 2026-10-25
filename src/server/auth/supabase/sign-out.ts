import type { SupabaseClient } from "@supabase/supabase-js";

/** Revokes the current session (this device) and clears its cookies. */
export async function endSession(client: () => Promise<SupabaseClient>): Promise<void> {
  const supabase = await client();
  await supabase.auth.signOut({ scope: "local" });
}
