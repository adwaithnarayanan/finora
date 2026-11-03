import "server-only";

import { redirect } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";

import { getOwnerDirectory } from "@/server/db";

import { authorizeOwner } from "./authorize";
import { createSupabaseServerClient } from "./supabase/server-client";
import { SupabaseIdentityProvider } from "./supabase/identity";
import type { AuthorizedOwner, OwnerAccess } from "./types";

export const getOwnerAccess = cache(async (): Promise<OwnerAccess> => {
  // Authorisation is always request-time work (JWT expiry is checked against
  await connection();
  return authorizeOwner({
    identities: new SupabaseIdentityProvider(createSupabaseServerClient),
    // Resolved lazily so nothing touches the database before the request's
    owners: {
      findByIdentity: (identity) =>
        getOwnerDirectory().findByIdentity(identity),
    },
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
