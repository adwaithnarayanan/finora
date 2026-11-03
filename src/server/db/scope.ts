import { parseOwnerId } from "@/domain/owner";
import type { AuthorizedOwner, VerifiedIdentity } from "@/server/auth/types";

import type { Prisma, PrismaClient } from "./generated/client";

export type ScopedTx = Prisma.TransactionClient;

/**
 * Runs `fn` in a transaction whose RLS context is the authorised owner.
 *
 * The owner id is set with set_config(..., is_local => true), so it is
 * discarded at COMMIT/ROLLBACK and never survives on a pooled connection.
 * Queries issued outside such a transaction carry no owner context and match
 * no owner-scoped rows (fail closed).
 */
export async function runInOwnerScope<T>(
  db: PrismaClient,
  owner: AuthorizedOwner,
  fn: (tx: ScopedTx) => Promise<T>,
): Promise<T> {
  // Re-validate at runtime: the type brand cannot stop a cast.
  const ownerId = parseOwnerId(owner.ownerId);
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('finora.owner_id', ${ownerId}, true)`;
    return fn(tx);
  });
}

export async function runInIdentityContext<T>(
  db: PrismaClient,
  identity: VerifiedIdentity,
  fn: (tx: ScopedTx) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('finora.auth_provider', ${identity.provider}, true), set_config('finora.auth_subject', ${identity.subject}, true)`;
    return fn(tx);
  });
}
