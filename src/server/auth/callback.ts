/**
 * Provider-neutral parts of the OAuth callback: input validation and the
 * mapping from provider errors to the generic notices the sign-in page shows.
 * Nothing from the provider's error text is ever echoed (it can contain
 * email addresses or configuration details).
 */

/** httpOnly cookie carrying the sanitised post-login path across the round trip. */
export const NEXT_PATH_COOKIE = "finora-oauth-next";
export const NEXT_PATH_COOKIE_MAX_AGE = 600;

export type SignInNotice = "oauth" | "denied";

/** Supabase PKCE authorization codes are UUIDs; accept only short opaque tokens. */
export function isAuthorizationCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._~-]{8,256}$/.test(value);
}

/**
 * `denied` when the provider (or Supabase, e.g. sign-ups disabled for an
 * unknown Google account) refused the user; `oauth` for every other failure.
 */
export function callbackErrorNotice(params: URLSearchParams): SignInNotice | null {
  if (!params.has("error") && !params.has("error_code")) return null;
  const code = params.get("error_code");
  return code === "signup_disabled" || code === "user_banned" ? "denied" : "oauth";
}

export const SIGN_IN_NOTICES: Record<SignInNotice, string> = {
  oauth: "Sign-in with Google did not complete. Try again.",
  denied: "That Google account is not authorised to use Finora.",
};

export function parseSignInNotice(value: unknown): SignInNotice | undefined {
  return value === "oauth" || value === "denied" ? value : undefined;
}
