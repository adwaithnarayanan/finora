import type { OwnerId } from "@/domain/owner";

export interface VerifiedIdentity {
  readonly provider: string;
  readonly subject: string;
}

export interface IdentityProvider {
  getVerifiedIdentity(): Promise<VerifiedIdentity | null>;
}

export type OwnerRecord = {
  readonly id: OwnerId;
  readonly disabled: boolean;
};

export interface OwnerDirectory {
  findByIdentity(identity: VerifiedIdentity): Promise<OwnerRecord | null>;
}

declare const authorizedOwnerBrand: unique symbol;

export type AuthorizedOwner = {
  readonly ownerId: OwnerId;
  readonly identity: VerifiedIdentity;
  readonly [authorizedOwnerBrand]: true;
};

export type OwnerAccess =
  | { readonly status: "authorized"; readonly owner: AuthorizedOwner }
  | { readonly status: "unauthenticated" }
  | { readonly status: "forbidden"; readonly reason: "no-owner" | "disabled" };
