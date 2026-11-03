export const NEXT_PATH_COOKIE = "finora-oauth-next";
export const NEXT_PATH_COOKIE_MAX_AGE = 600;

export type SignInNotice = "oauth" | "denied";

export function isAuthorizationCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._~-]{8,256}$/.test(value);
}

export function callbackErrorNotice(
  params: URLSearchParams,
): SignInNotice | null {
  if (!params.has("error") && !params.has("error_code")) return null;
  const code = params.get("error_code");
  return code === "signup_disabled" || code === "user_banned"
    ? "denied"
    : "oauth";
}

export const SIGN_IN_NOTICES: Record<SignInNotice, string> = {
  oauth: "Sign-in with Google did not complete. Try again.",
  denied: "That Google account is not authorised to use Finora.",
};

export function parseSignInNotice(value: unknown): SignInNotice | undefined {
  return value === "oauth" || value === "denied" ? value : undefined;
}
