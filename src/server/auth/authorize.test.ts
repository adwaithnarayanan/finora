import { describe, expect, it, vi } from "vitest";

import { parseOwnerId } from "@/domain/owner";

import { authorizeOwner } from "./authorize";
import type {
  IdentityProvider,
  OwnerDirectory,
  OwnerRecord,
  VerifiedIdentity,
} from "./types";

const identity: VerifiedIdentity = { provider: "supabase", subject: "user-1" };
const ownerId = parseOwnerId("3f6c1a52-8a3b-4c6e-9d1f-0a2b3c4d5e6f");

function deps(
  verified: VerifiedIdentity | null,
  record: OwnerRecord | null,
) {
  const identities: IdentityProvider = {
    getVerifiedIdentity: vi.fn(async () => verified),
  };
  const owners: OwnerDirectory = {
    findByIdentity: vi.fn(async () => record),
  };
  return { identities, owners };
}

describe("authorizeOwner", () => {
  it("denies requests without a verified identity", async () => {
    const d = deps(null, { id: ownerId, disabled: false });
    expect(await authorizeOwner(d)).toEqual({ status: "unauthenticated" });
    expect(d.owners.findByIdentity).not.toHaveBeenCalled();
  });

  it("denies authenticated users with no owner mapping", async () => {
    expect(await authorizeOwner(deps(identity, null))).toEqual({
      status: "forbidden",
      reason: "no-owner",
    });
  });

  it("denies disabled owners", async () => {
    expect(
      await authorizeOwner(deps(identity, { id: ownerId, disabled: true })),
    ).toEqual({ status: "forbidden", reason: "disabled" });
  });

  it("authorises a mapped, active owner using the internal owner id", async () => {
    const d = deps(identity, { id: ownerId, disabled: false });
    const access = await authorizeOwner(d);
    expect(access.status).toBe("authorized");
    if (access.status !== "authorized") return;
    expect(access.owner.ownerId).toBe(ownerId);
    expect(access.owner.ownerId).not.toBe(identity.subject);
    expect(access.owner.identity).toEqual(identity);
    expect(Object.isFrozen(access.owner)).toBe(true);
    expect(d.owners.findByIdentity).toHaveBeenCalledWith(identity);
  });

  it("propagates directory failures instead of granting access", async () => {
    const d = deps(identity, null);
    d.owners.findByIdentity = vi.fn(async () => {
      throw new Error("db down");
    });
    await expect(authorizeOwner(d)).rejects.toThrow("db down");
  });
});
