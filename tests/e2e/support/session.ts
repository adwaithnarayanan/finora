import type { BrowserContext } from "@playwright/test";
import { createServerClient } from "@supabase/ssr";
import pg from "pg";

import { readLocalSupabase } from "../../../scripts/lib/local-supabase.mjs";
import { sessionFor } from "../../support/google-simulation";

/**
 * Signs `context` in as `email` by installing the same auth cookies
 * @supabase/ssr would set after a Google login. `method: "otp"` installs a
 * real, non-Google session instead (which Finora must refuse).
 */
export async function signInAs(
  context: BrowserContext,
  baseURL: string,
  email: string,
  method: "oauth" | "otp" = "oauth",
): Promise<void> {
  const local = readLocalSupabase();
  const db = new pg.Client({ connectionString: local.migrationDatabaseUrl.replace(/\?.*$/, "") });
  await db.connect();
  try {
    const session = await sessionFor(local, db, email, method);
    const written: { name: string; value: string }[] = [];
    const client = createServerClient(local.apiUrl, local.publishableKey, {
      cookies: { getAll: () => [], setAll: (cookies) => void written.push(...cookies) },
    });
    const { error } = await client.auth.setSession({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    });
    if (error) throw new Error(`setSession failed: ${error.code}`);
    await context.addCookies(
      written.map(({ name, value }) => ({ name, value, url: baseURL, httpOnly: false, sameSite: "Lax" as const })),
    );
  } finally {
    await db.end();
  }
}
