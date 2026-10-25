import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import type { NextRequest } from "next/server";

import { authorizeOwner } from "@/server/auth/authorize";
import { NEXT_PATH_COOKIE, callbackErrorNotice, isAuthorizationCode } from "@/server/auth/callback";
import { safeNextPath } from "@/server/auth/redirect";
import { OAUTH_CALLBACK_PATH, completeOAuthSignIn } from "@/server/auth/supabase/oauth";
import { createSupabaseServerClient } from "@/server/auth/supabase/server-client";
import { ACTIVE_SIGN_IN_METHOD } from "@/server/auth/supabase/sign-in-method";
import { endSession } from "@/server/auth/supabase/sign-out";
import { getOwnerDirectory } from "@/server/db";

/**
 * OAuth return point (DEFERRED with Google sign-in, ADR 0003). While email and
 * password is the active method this route does nothing but return 404: no
 * code is exchanged and no cookie is touched, so a stale or forged callback
 * cannot create a session. In Google mode, Supabase Auth redirects here with
 * `?code=` (PKCE) or `?error=…`, and a session is only kept if it belongs to
 * the authorised owner.
 */
export async function GET(request: NextRequest): Promise<never> {
  if (ACTIVE_SIGN_IN_METHOD !== "google") notFound();
  const params = request.nextUrl.searchParams;
  const jar = await cookies();
  const next = safeNextPath(jar.get(NEXT_PATH_COOKIE)?.value);
  jar.delete({ name: NEXT_PATH_COOKIE, path: OAUTH_CALLBACK_PATH });

  const notice = callbackErrorNotice(params);
  if (notice) redirect(`/login?error=${notice}`);

  const code = params.get("code");
  if (!isAuthorizationCode(code)) redirect("/login?error=oauth");

  const identities = await completeOAuthSignIn(createSupabaseServerClient, code);
  if (!identities) redirect("/login?error=oauth");

  const access = await authorizeOwner({ identities, owners: getOwnerDirectory() });
  if (access.status !== "authorized") {
    await endSession(createSupabaseServerClient);
    redirect("/unauthorized");
  }
  redirect(next);
}
