import { randomInt } from "node:crypto";

import { type Session, createClient } from "@supabase/supabase-js";
import type pg from "pg";

/**
 * LOCAL-ONLY stand-in for Google. Real Google OAuth cannot run in automated
 * tests (the Auth server hard-codes accounts.google.com), so these helpers
 * write to the local Auth database exactly what a Google login leaves behind:
 *
 *  - a `google` row in auth.identities (what Supabase's automatic linking
 *    creates when a verified Google email matches an existing user), and
 *  - a session whose recorded sign-in method (`amr`) is `oauth`.
 *
 * Everything downstream (token verification, getUser, Finora's approval and
 * owner checks) is the real code path. Never point these at a hosted project.
 */

type Local = { apiUrl: string; publishableKey: string; secretKey: string };

const noPersist = { auth: { persistSession: false, autoRefreshToken: false } };

export const randomGoogleId = () => `1${Array.from({ length: 20 }, () => randomInt(10)).join("")}`;

export async function linkSimulatedGoogleIdentity(
  db: pg.Client,
  user: { id: string; email: string },
  options: { googleId?: string; emailVerified?: boolean; email?: string } = {},
): Promise<string> {
  const googleId = options.googleId ?? randomGoogleId();
  await db.query(
    `INSERT INTO auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
     VALUES ($1, $2, $3, 'google', now(), now(), now())`,
    [
      googleId,
      user.id,
      JSON.stringify({
        iss: "https://accounts.google.com",
        sub: googleId,
        email: options.email ?? user.email,
        email_verified: options.emailVerified ?? true,
      }),
    ],
  );
  return googleId;
}

/**
 * A real Auth session for `email`, created with an admin magic link. With
 * `method: "oauth"` its amr is rewritten to `oauth` and the token refreshed,
 * which is what a completed Google login produces; otherwise it stays `otp`
 * (a non-Google session that Finora must refuse).
 */
export async function sessionFor(
  local: Local,
  db: pg.Client,
  email: string,
  method: "oauth" | "otp" = "oauth",
): Promise<Session> {
  const admin = createClient(local.apiUrl, local.secretKey, noPersist).auth.admin;
  const link = await admin.generateLink({ type: "magiclink", email });
  if (link.error) throw new Error(`generateLink failed: ${link.error.code}`);
  const client = createClient(local.apiUrl, local.publishableKey, noPersist);
  const verified = await client.auth.verifyOtp({ token_hash: link.data.properties.hashed_token, type: "magiclink" });
  if (verified.error || !verified.data.session) throw new Error(`verifyOtp failed: ${verified.error?.code}`);
  if (method === "otp") return verified.data.session;

  const claims = await client.auth.getClaims(verified.data.session.access_token);
  const sessionId = claims.data?.claims["session_id"];
  await db.query("UPDATE auth.mfa_amr_claims SET authentication_method = 'oauth' WHERE session_id = $1", [sessionId]);
  const refreshed = await client.auth.refreshSession({ refresh_token: verified.data.session.refresh_token });
  if (refreshed.error || !refreshed.data.session) throw new Error(`refresh failed: ${refreshed.error?.code}`);
  return refreshed.data.session;
}

/** A Supabase client holding `session` in memory, as the app's server client would. */
export async function clientWithSession(local: Local, session: Session) {
  const client = createClient(local.apiUrl, local.publishableKey, noPersist);
  const { error } = await client.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  });
  if (error) throw new Error(`setSession failed: ${error.code}`);
  return client;
}
