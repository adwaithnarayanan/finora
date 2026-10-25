import type { SupabaseClient } from "@supabase/supabase-js";

import { getAuthEnv, getSiteEnv } from "@/server/env";

import type { IdentityProvider } from "../types";
import { GOOGLE_POLICY, SIGN_IN_PROVIDER, SupabaseIdentityProvider } from "./identity";

/** The app route Supabase Auth returns to; must be on the Auth redirect allow list. */
export const OAUTH_CALLBACK_PATH = "/auth/callback";

type ClientFactory = () => Promise<SupabaseClient>;

/**
 * Starts Google sign-in (PKCE): Supabase stores the code verifier in a cookie
 * through the server client and returns the authorize URL to send the browser
 * to. Returns null on failure, or if the URL is not on our own Auth server.
 */
export async function startGoogleSignIn(client: ClientFactory): Promise<string | null> {
  const supabase = await client();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: SIGN_IN_PROVIDER,
    options: {
      redirectTo: new URL(OAUTH_CALLBACK_PATH, getSiteEnv().NEXT_PUBLIC_SITE_URL).toString(),
      // Let the user pick the account rather than silently reusing one.
      queryParams: { prompt: "select_account" },
    },
  });
  if (error || !data.url || !URL.canParse(data.url)) return null;
  if (new URL(data.url).origin !== new URL(getAuthEnv().SUPABASE_URL).origin) return null;
  return data.url;
}

/**
 * Exchanges the callback's authorization code (with the PKCE verifier cookie)
 * for a session. Returns an identity provider bound to that new session, or
 * null if the exchange failed. The provider applies the Google policy; the
 * callback route only runs while Google is the active method.
 */
export async function completeOAuthSignIn(
  client: ClientFactory,
  code: string,
): Promise<IdentityProvider | null> {
  const supabase = await client();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return null;
  return new SupabaseIdentityProvider(async () => supabase, GOOGLE_POLICY);
}
