import "server-only";

import { redirect } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";

import { getOwnerDirectory } from "@/server/db";

import { authorizeOwner } from "./authorize";
import { createSupabaseServerClient } from "./supabase/server-client";
import { SupabaseIdentityProvider } from "./supabase/identity";
import type { AuthorizedOwner, OwnerAccess } from "./types";

/**
 * Data Access Layer entry point. Every protected page, layout, server action
 * and route handler must call one of these; proxy.ts redirects are only an
 * optimisation. Memoised per request (React cache), never across requests.
 */
export const getOwnerAccess = cache(async (): Promise<OwnerAccess> => {
  // Authorisation is always request-time work (JWT expiry is checked against
  // the clock); never let it be prerendered or cached.
  await connection();
  return authorizeOwner({
    identities: new SupabaseIdentityProvider(createSupabaseServerClient),
    // Resolved lazily so nothing touches the database before the request's
    // cookies have been read (keeps prerendering away from runtime config).
    owners: { findByIdentity: (identity) => getOwnerDirectory().findByIdentity(identity) },
  });
});

export async function requireOwner(): Promise<AuthorizedOwner> {
  const access = await getOwnerAccess();
  switch (access.status) {
    case "authorized":
      return access.owner;
    case "unauthenticated":
      redirect("/login");
    case "forbidden":
      redirect("/unauthorized");
  }
}
