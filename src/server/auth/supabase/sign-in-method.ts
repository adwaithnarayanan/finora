export type SignInMethod = "password" | "google";

/**
 * The single interactive sign-in method Finora currently accepts. Email and
 * password is the current mode; Google OAuth is deferred (ADR 0003). This is a
 * code constant, not configuration, so it cannot be flipped at runtime.
 * Restoring Google: set this to "google" and follow ADR 0003 "Restoring Google".
 * Keep in sync with scripts/lib/provisioning.mjs (a test checks).
 */
export const ACTIVE_SIGN_IN_METHOD: SignInMethod = "password";
