import type {
  AuthorizedOwner,
  IdentityProvider,
  OwnerAccess,
  OwnerDirectory,
} from "./types";

/**
 * Resolves the request's verified identity to an owner. Fails closed: no
 * identity → unauthenticated; no mapping or a disabled owner → forbidden.
 * Provider-agnostic, so it is unit-tested with fakes.
 */
export async function authorizeOwner(deps: {
  identities: IdentityProvider;
  owners: OwnerDirectory;
}): Promise<OwnerAccess> {
  const identity = await deps.identities.getVerifiedIdentity();
  if (!identity) return { status: "unauthenticated" };

  const owner = await deps.owners.findByIdentity(identity);
  if (!owner) return { status: "forbidden", reason: "no-owner" };
  if (owner.disabled) return { status: "forbidden", reason: "disabled" };

  const authorized = Object.freeze({
    ownerId: owner.id,
    identity: Object.freeze({ ...identity }),
  }) as AuthorizedOwner;
  return { status: "authorized", owner: authorized };
}
