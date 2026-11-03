import type { SupabaseClient } from "@supabase/supabase-js";

import { getAuthEnv, getSiteEnv } from "@/server/env";

import type { IdentityProvider } from "../types";
import {
  GOOGLE_POLICY,
  SIGN_IN_PROVIDER,
  SupabaseIdentityProvider,
} from "./identity";

export const OAUTH_CALLBACK_PATH = "/auth/callback";

type ClientFactory = () => Promise<SupabaseClient>;

export async function startGoogleSignIn(
  client: ClientFactory,
): Promise<string | null> {
  const supabase = await client();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: SIGN_IN_PROVIDER,
    options: {
      redirectTo: new URL(
        OAUTH_CALLBACK_PATH,
        getSiteEnv().NEXT_PUBLIC_SITE_URL,
      ).toString(),
      queryParams: { prompt: "select_account" },
    },
  });
  if (error || !data.url || !URL.canParse(data.url)) return null;
  if (new URL(data.url).origin !== new URL(getAuthEnv().SUPABASE_URL).origin)
    return null;
  return data.url;
}

export async function completeOAuthSignIn(
  client: ClientFactory,
  code: string,
): Promise<IdentityProvider | null> {
  const supabase = await client();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return null;
  return new SupabaseIdentityProvider(async () => supabase, GOOGLE_POLICY);
}
