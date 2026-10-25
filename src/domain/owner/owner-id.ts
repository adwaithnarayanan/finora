import { isCanonicalUuid } from "@/domain/shared/uuid";

declare const ownerIdBrand: unique symbol;

/**
 * Finora's internal identifier for an owner (a UUID). Distinct from any auth
 * provider's user id; values only come from server-side owner resolution.
 */
export type OwnerId = string & { readonly [ownerIdBrand]: true };

export class InvalidOwnerIdError extends Error {
  constructor() {
    super("Owner id must be a canonical lowercase UUID");
    this.name = "InvalidOwnerIdError";
  }
}

export function parseOwnerId(value: unknown): OwnerId {
  if (!isCanonicalUuid(value)) {
    throw new InvalidOwnerIdError();
  }
  return value as OwnerId;
}
