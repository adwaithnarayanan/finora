import "server-only";

import type { AuthorizedOwner } from "@/server/auth/types";
import type { LedgerStore } from "@/server/ledger/store";

import { getPrismaClient } from "./client";
import { PrismaLedgerStore } from "./ledger-store";
import { PrismaOwnerDirectory } from "./owner-directory";
import { type ScopedTx, runInOwnerScope } from "./scope";

export type { ScopedTx };

/**
 * The only way application code touches owner data: inside a transaction
 * scoped (and RLS-enforced) to an owner that `requireOwner()` authorised.
 */
export function withOwnerScope<T>(
  owner: AuthorizedOwner,
  fn: (tx: ScopedTx) => Promise<T>,
): Promise<T> {
  return runInOwnerScope(getPrismaClient(), owner, fn);
}

export function getOwnerDirectory(): PrismaOwnerDirectory {
  return new PrismaOwnerDirectory(getPrismaClient());
}

/** Ledger persistence for one owner-scoped transaction (see src/server/ledger). */
export function withLedgerStore<T>(
  owner: AuthorizedOwner,
  work: (store: LedgerStore) => Promise<T>,
): Promise<T> {
  return withOwnerScope(owner, (tx) => work(new PrismaLedgerStore(tx, owner.ownerId)));
}
