import { parseOwnerId } from "@/domain/owner";
import type {
  OwnerDirectory,
  OwnerRecord,
  VerifiedIdentity,
} from "@/server/auth/types";

import type { PrismaClient } from "./generated/client";
import { runInIdentityContext } from "./scope";

export class PrismaOwnerDirectory implements OwnerDirectory {
  constructor(private readonly db: PrismaClient) {}

  async findByIdentity(identity: VerifiedIdentity): Promise<OwnerRecord | null> {
    const mapping = await runInIdentityContext(this.db, identity, (tx) =>
      tx.ownerIdentity.findUnique({
        where: {
          provider_subject: {
            provider: identity.provider,
            subject: identity.subject,
          },
        },
        select: { owner: { select: { id: true, disabledAt: true } } },
      }),
    );
    if (!mapping) return null;
    return {
      id: parseOwnerId(mapping.owner.id),
      disabled: mapping.owner.disabledAt !== null,
    };
  }
}
