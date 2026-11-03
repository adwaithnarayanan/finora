import pg from "pg";
import { afterAll, inject } from "vitest";

import { createPrismaClient } from "@/server/db/client";

import { runCleanup } from "./cleanup";
import { seedOwner } from "./db";
import { authorize, financeFor } from "./ledger";
import {
  type MigrationSet,
  type ScratchDatabase,
  createMigratedScratchDatabase,
  deployMigrations,
  migrationSet,
} from "./scratch-db";

function appUrl(scratch: ScratchDatabase): string {
  const url = new URL(inject("local").appDatabaseUrl);
  url.pathname = `/${scratch.name}`;
  return url.toString();
}

export function scratchHarness() {
  const scratches: ScratchDatabase[] = [];
  const sets: MigrationSet[] = [];
  const closers: [string, () => Promise<unknown>][] = [];

  afterAll(async () => {
    await runCleanup([
      ...closers,
      ...scratches.map((s) => [`drop ${s.name}`, () => s.drop()] as const),
      ...sets.map(
        (s) =>
          [
            "remove a temporary migrations copy",
            async () => s.remove(),
          ] as const,
      ),
    ]);
  });

  async function scratchDatabase(
    label: string,
    through?: string,
  ): Promise<ScratchDatabase> {
    const set = through === undefined ? undefined : migrationSet({ through });
    if (set) sets.push(set);
    const scratch = await createMigratedScratchDatabase(label, {
      migrate: (url) => deployMigrations(url, set),
    });
    scratches.push(scratch);
    return scratch;
  }

  function financeOn(scratch: ScratchDatabase, connections = 1) {
    const prisma = createPrismaClient(appUrl(scratch), connections);
    closers.push([
      "disconnect a scratch Prisma client",
      () => prisma.$disconnect(),
    ]);
    return { prisma, finance: financeFor(prisma) };
  }

  async function appClientOn(scratch: ScratchDatabase): Promise<pg.Client> {
    const client = new pg.Client({ connectionString: appUrl(scratch) });
    await client.connect();
    closers.push(["close a scratch app connection", () => client.end()]);
    return client;
  }

  function deployThrough(scratch: ScratchDatabase, through: string): void {
    const set = migrationSet({ through });
    sets.push(set);
    deployMigrations(scratch.url, set);
  }

  return { scratchDatabase, financeOn, appClientOn, deployThrough };
}

export async function newOwner(
  db: pg.Client,
  finance: ReturnType<typeof financeFor>,
  prisma: Parameters<typeof authorize>[0],
) {
  const seeded = await seedOwner(db);
  const owner = await authorize(prisma, seeded.subject);
  await finance.initializeDefaultCategories(owner);
  const categories = await finance.listCategories(owner);
  const named = (name: string) => categories.find((c) => c.name === name)!;
  return { seeded, owner, named };
}
