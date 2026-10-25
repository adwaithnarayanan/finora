import type { SupabaseClient } from "@supabase/supabase-js";

import type { IdentityProvider, VerifiedIdentity } from "../types";

export const SUPABASE_PROVIDER = "supabase";

type Claims = Record<string, unknown>;

/**
 * Maps verified Supabase JWT claims to an identity. Only regular signed-in
 * users qualify: anonymous users and non-`authenticated` roles (anon,
 * service_role) are rejected.
 */
export function claimsToIdentity(claims: Claims | null | undefined): VerifiedIdentity | null {
  if (!claims) return null;
  const { sub, role, is_anonymous: isAnonymous } = claims;
  if (typeof sub !== "string" || sub.length === 0 || sub.length > 255) return null;
  if (role !== "authenticated") return null;
  if (isAnonymous === true) return null;
  return { provider: SUPABASE_PROVIDER, subject: sub };
}

/**
 * Verifies the session's access token with `getClaims()` (signature + expiry,
 * checked against the Auth server's keys). `getSession()` is never used for
 * identity because cookie contents are not trustworthy on their own.
 */
export class SupabaseIdentityProvider implements IdentityProvider {
  constructor(private readonly client: () => Promise<SupabaseClient>) {}

  async getVerifiedIdentity(): Promise<VerifiedIdentity | null> {
    const supabase = await this.client();
    const { data, error } = await supabase.auth.getClaims();
    if (error || !data) return null;
    return claimsToIdentity(data.claims);
  }
}
