import type pg from "pg";

import { authorizeOwner } from "@/server/auth/authorize";
import type { AuthorizedOwner } from "@/server/auth/types";
import type { PrismaClient } from "@/server/db/generated/client";
import { PrismaFinanceStore } from "@/server/db/finance-store";
import { PrismaLedgerStore } from "@/server/db/ledger-store";
import { PrismaOwnerDirectory } from "@/server/db/owner-directory";
import { runInOwnerScope } from "@/server/db/scope";
import {
  type FinanceStores,
  createFinanceService,
} from "@/server/finance/service";
import {
  type LedgerRunner,
  createLedgerService,
} from "@/server/ledger/service";
import type { LedgerStore } from "@/server/ledger/store";

import { TEST_PROVIDER } from "./db";

export async function authorize(
  prisma: PrismaClient,
  subject: string,
): Promise<AuthorizedOwner> {
  const access = await authorizeOwner({
    identities: {
      getVerifiedIdentity: async () => ({ provider: TEST_PROVIDER, subject }),
    },
    owners: new PrismaOwnerDirectory(prisma),
  });
  if (access.status !== "authorized")
    throw new Error(`expected authorized, got ${access.status}`);
  return access.owner;
}

export function runnerFor(
  prisma: PrismaClient,
  wrap: (store: LedgerStore) => LedgerStore = (store) => store,
): LedgerRunner {
  return (owner, work) =>
    runInOwnerScope(prisma, owner, (tx) =>
      work(wrap(new PrismaLedgerStore(tx, owner.ownerId))),
    );
}

export function ledgerFor(
  prisma: PrismaClient,
  wrap?: (store: LedgerStore) => LedgerStore,
) {
  return createLedgerService(runnerFor(prisma, wrap));
}

export async function asOwner<T>(
  app: pg.Client,
  ownerId: string | null,
  work: () => Promise<T>,
): Promise<T> {
  await app.query("BEGIN");
  try {
    if (ownerId)
      await app.query("SELECT set_config('finora.owner_id', $1, true)", [
        ownerId,
      ]);
    const result = await work();
    await app.query("COMMIT");
    return result;
  } catch (error) {
    await app.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

let keySeq = 0;
export const newKey = (label = "k") =>
  `itest-${label}-${Date.now()}-${++keySeq}`;

export const line = (
  accountId: string,
  side: "debit" | "credit",
  amount: string,
  currency = "INR",
  memo?: string,
) => ({
  accountId,
  side,
  amount,
  currency,
  ...(memo === undefined ? {} : { memo }),
});

export function financeFor(
  prisma: PrismaClient,
  wrap: (stores: FinanceStores) => FinanceStores = (stores) => stores,
) {
  return createFinanceService((owner, work) =>
    runInOwnerScope(prisma, owner, (tx) =>
      work(
        wrap({
          ledger: new PrismaLedgerStore(tx, owner.ownerId),
          finance: new PrismaFinanceStore(tx, owner.ownerId),
        }),
      ),
    ),
  );
}
