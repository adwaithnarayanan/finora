import "server-only";

import type { AuthorizedOwner } from "@/server/auth/types";
import type { FinanceStore } from "@/server/finance/store";
import type { LedgerStore } from "@/server/ledger/store";

import { getPrismaClient } from "./client";
import { PrismaFinanceStore } from "./finance-store";
import { PrismaLedgerStore } from "./ledger-store";
import { PrismaOwnerDirectory } from "./owner-directory";
import { type ScopedTx, runInOwnerScope } from "./scope";

export type { ScopedTx };

export function withOwnerScope<T>(
  owner: AuthorizedOwner,
  fn: (tx: ScopedTx) => Promise<T>,
): Promise<T> {
  return runInOwnerScope(getPrismaClient(), owner, fn);
}

export function getOwnerDirectory(): PrismaOwnerDirectory {
  return new PrismaOwnerDirectory(getPrismaClient());
}

export function withLedgerStore<T>(
  owner: AuthorizedOwner,
  work: (store: LedgerStore) => Promise<T>,
): Promise<T> {
  return withOwnerScope(owner, (tx) =>
    work(new PrismaLedgerStore(tx, owner.ownerId)),
  );
}

export function withFinanceStores<T>(
  owner: AuthorizedOwner,
  work: (stores: { ledger: LedgerStore; finance: FinanceStore }) => Promise<T>,
): Promise<T> {
  return withOwnerScope(owner, (tx) =>
    work({
      ledger: new PrismaLedgerStore(tx, owner.ownerId),
      finance: new PrismaFinanceStore(tx, owner.ownerId),
    }),
  );
}
