import type { SupabaseClient, User } from "@supabase/supabase-js";

import type { IdentityProvider, VerifiedIdentity } from "../types";
import { ACTIVE_SIGN_IN_METHOD, type SignInMethod } from "./sign-in-method";

export const SUPABASE_PROVIDER = "supabase";

/** Provider name of the (deferred) Google sign-in method. */
export const SIGN_IN_PROVIDER = "google";

/**
 * Keys in the Supabase user's `app_metadata` recording what an operator
 * approved with `npm run owner:provision -- complete`. `app_metadata` can only
 * be written with the secret key, never by the user. Keep in sync with
 * scripts/lib/provisioning.mjs (a test checks).
 */
export const APPROVED_PASSWORD_EMAIL_KEY = "finora_password_email";
export const APPROVED_GOOGLE_ID_KEY = "finora_google_id";

/** Identities that cannot be used to sign in while their providers are disabled. */
const NON_INTERACTIVE = new Set(["email", "phone"]);

type Claims = Record<string, unknown>;
type UserFacts = Pick<User, "email" | "email_confirmed_at" | "app_metadata" | "identities">;

/**
 * What a session must satisfy for one sign-in method: the `amr` method the
 * Auth server records for it, and the operator approval on the user.
 */
export interface SignInPolicy {
  readonly method: SignInMethod;
  readonly amrMethod: string;
  isApproved(user: UserFacts): boolean;
}

/**
 * Email/password: the user's confirmed email must equal the email an operator
 * approved. A changed email, or an account the operator never completed, is
 * refused (fail closed). The password itself is only ever set by an operator.
 */
export function hasApprovedPasswordAccount(user: UserFacts): boolean {
  const approved = user.app_metadata?.[APPROVED_PASSWORD_EMAIL_KEY];
  const email = typeof user.email === "string" ? user.email.toLowerCase() : "";
  return (
    typeof approved === "string" &&
    approved.length > 0 &&
    approved === email &&
    typeof user.email_confirmed_at === "string" &&
    user.email_confirmed_at.length > 0 &&
    (user.identities ?? []).some((i) => i.provider === "email")
  );
}

/**
 * Google (deferred): the user's only sign-in-capable identity must be the
 * verified Google account an operator approved. Supabase links a Google login
 * to an existing user by verified email; this makes access depend on the
 * specific approved Google account instead (fail closed on any other).
 */
export function hasApprovedGoogleIdentity(user: Pick<User, "app_metadata" | "identities">): boolean {
  const approved = user.app_metadata?.[APPROVED_GOOGLE_ID_KEY];
  if (typeof approved !== "string" || approved.length === 0) return false;
  const interactive = (user.identities ?? []).filter((i) => !NON_INTERACTIVE.has(i.provider));
  if (interactive.length !== 1) return false;
  const [google] = interactive;
  return (
    google!.provider === SIGN_IN_PROVIDER &&
    google!.id === approved &&
    google!.identity_data?.["email_verified"] === true
  );
}

export const PASSWORD_POLICY: SignInPolicy = {
  method: "password",
  amrMethod: "password",
  isApproved: hasApprovedPasswordAccount,
};

export const GOOGLE_POLICY: SignInPolicy = {
  method: "google",
  amrMethod: "oauth",
  isApproved: hasApprovedGoogleIdentity,
};

export const POLICIES: Record<SignInMethod, SignInPolicy> = {
  password: PASSWORD_POLICY,
  google: GOOGLE_POLICY,
};

export const ACTIVE_POLICY: SignInPolicy = POLICIES[ACTIVE_SIGN_IN_METHOD];

function signedInWith(amr: unknown, method: string): boolean {
  return (
    Array.isArray(amr) &&
    amr.some((entry) => typeof entry === "object" && entry !== null && (entry as Claims)["method"] === method)
  );
}

/**
 * Maps verified Supabase JWT claims to an identity. Only regular users whose
 * session came from the active sign-in method qualify: anonymous users,
 * non-`authenticated` roles (anon, service_role) and sessions created any
 * other way (OTP, magic/recovery/invite links, OAuth while in password mode,
 * passkeys...) are rejected. The Auth server records the method in the signed
 * `amr` claim.
 */
export function claimsToIdentity(
  claims: Claims | null | undefined,
  amrMethod: string = ACTIVE_POLICY.amrMethod,
): VerifiedIdentity | null {
  if (!claims) return null;
  const { sub, role, is_anonymous: isAnonymous, amr } = claims;
  if (typeof sub !== "string" || sub.length === 0 || sub.length > 255) return null;
  if (role !== "authenticated") return null;
  if (isAnonymous === true) return null;
  if (!signedInWith(amr, amrMethod)) return null;
  return { provider: SUPABASE_PROVIDER, subject: sub };
}

/**
 * Verifies the session's access token with `getClaims()` (signature + expiry,
 * checked against the Auth server's keys), then loads the user from the Auth
 * server with `getUser()` (authoritative identities and app_metadata, and
 * proof the session has not been revoked). `getSession()` is never used for
 * identity because cookie contents are not trustworthy on their own.
 */
export class SupabaseIdentityProvider implements IdentityProvider {
  constructor(
    private readonly client: () => Promise<SupabaseClient>,
    private readonly policy: SignInPolicy = ACTIVE_POLICY,
  ) {}

  async getVerifiedIdentity(): Promise<VerifiedIdentity | null> {
    const supabase = await this.client();
    const { data, error } = await supabase.auth.getClaims();
    if (error || !data) return null;
    const identity = claimsToIdentity(data.claims, this.policy.amrMethod);
    if (!identity) return null;

    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData.user || userData.user.id !== identity.subject) return null;
    return this.policy.isApproved(userData.user) ? identity : null;
  }
}
