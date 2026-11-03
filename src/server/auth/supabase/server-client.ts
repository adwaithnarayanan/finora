import "server-only";

import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

import { getAuthEnv } from "@/server/env";

export async function createSupabaseServerClient(): Promise<SupabaseClient> {
  // Read cookies first: this marks the render as request-time before any
  const cookieStore = await cookies();
  const env = getAuthEnv();
  return createServerClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components cannot set cookies. Session refresh is handled
          // in proxy.ts; actions and route handlers can set cookies normally.
        }
      },
    },
  });
}
