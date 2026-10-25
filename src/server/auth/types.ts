import type { OwnerId } from "@/domain/owner";

/**
 * An identity whose credentials the auth adapter has verified server-side.
 * `provider` + `subject` identify the user at the provider; they are never
 * used as Finora's owner id.
 */
export interface VerifiedIdentity {
  readonly provider: string;
  readonly subject: string;
}

/** Port implemented by the auth adapter (Supabase today). */
export interface IdentityProvider {
  /** Returns the verified identity for the current request, or null. */
  getVerifiedIdentity(): Promise<VerifiedIdentity | null>;
}

export type OwnerRecord = {
  readonly id: OwnerId;
  readonly disabled: boolean;
};

/** Port implemented by the persistence layer. */
export interface OwnerDirectory {
  findByIdentity(identity: VerifiedIdentity): Promise<OwnerRecord | null>;
}

declare const authorizedOwnerBrand: unique symbol;

/**
 * Proof that the current request is authorised as this owner. Only
 * `authorizeOwner` can create one; owner-scoped data access requires it, so an
 * owner id from the browser can never reach the database layer.
 */
export type AuthorizedOwner = {
  readonly ownerId: OwnerId;
  readonly identity: VerifiedIdentity;
  readonly [authorizedOwnerBrand]: true;
};

export type OwnerAccess =
  | { readonly status: "authorized"; readonly owner: AuthorizedOwner }
  | { readonly status: "unauthenticated" }
  | { readonly status: "forbidden"; readonly reason: "no-owner" | "disabled" };
