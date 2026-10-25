import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

import { isPublicPath } from "@/server/auth/routes";
import { getAuthEnv } from "@/server/env";

/**
 * Runs before every page request to (1) refresh the Supabase session cookies
 * and (2) send signed-out visitors to /login early. (2) is an optimisation
 * only: protected pages and actions authorise themselves via requireOwner().
 */
export async function proxy(request: NextRequest) {
  const env = getAuthEnv();
  let response = NextResponse.next({ request });

  const supabase = createServerClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
        for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
      },
    },
  });

  // Verifies (and if needed refreshes) the session. Do not add logic between
  // client creation and this call; see @supabase/ssr docs.
  const { data } = await supabase.auth.getClaims();

  const { pathname, search } = request.nextUrl;
  const isNavigation = request.method === "GET" || request.method === "HEAD";
  if (!data?.claims && isNavigation && !isPublicPath(pathname)) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = "";
    if (pathname !== "/") loginUrl.searchParams.set("next", `${pathname}${search}`);
    const redirect = NextResponse.redirect(loginUrl);
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
    redirect.headers.set("Cache-Control", "private, no-store");
    return redirect;
  }
  return response;
}

export const config = {
  matcher: [
    // Everything except static assets and image optimisation.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
