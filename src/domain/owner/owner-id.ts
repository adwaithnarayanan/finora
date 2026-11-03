import { isCanonicalUuid } from "@/domain/shared/uuid";

declare const ownerIdBrand: unique symbol;

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
