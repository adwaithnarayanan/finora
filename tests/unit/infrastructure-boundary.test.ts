import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/** Lints in-memory source with the real config; nothing invalid touches disk. */
const eslint = new ESLint({ cwd: process.cwd() });

async function restricted(source: string, filePath: string) {
  const [result] = await eslint.lintText(`${source}\nexport {};\n`, { filePath });
  return (result?.messages ?? []).filter((m) => m.ruleId === "no-restricted-imports");
}

const PRISMA_IMPORTS = [
  'import { PrismaClient } from "@/server/db/generated/client";',
  'import { getPrismaClient } from "@/server/db/client";',
  'import { runInOwnerScope } from "@/server/db/scope";',
  'import { PrismaLedgerStore } from "@/server/db/ledger-store";',
  'import { PrismaPg } from "@prisma/adapter-pg";',
  'import pg from "pg";',
  'import { PrismaClient } from "../server/db/generated/client";',
];

describe("infrastructure import boundaries", () => {
  it.each(PRISMA_IMPORTS)("app code may not import Prisma internals: %s", async (source) => {
    expect(await restricted(source, "src/app/(app)/probe.tsx")).not.toHaveLength(0);
    expect(await restricted(source, "src/features/auth/probe.ts")).not.toHaveLength(0);
    expect(await restricted(source, "src/server/auth/supabase/probe.ts")).not.toHaveLength(0);
    expect(await restricted(source, "src/server/ledger/probe.ts")).not.toHaveLength(0);
  }, 30_000);

  it("app code may not import Supabase SDKs directly", async () => {
    for (const source of [
      'import { createServerClient } from "@supabase/ssr";',
      'import { createClient } from "@supabase/supabase-js";',
    ]) {
      expect(await restricted(source, "src/app/(app)/probe.tsx")).not.toHaveLength(0);
      expect(await restricted(source, "src/server/db/probe.ts")).not.toHaveLength(0);
    }
  }, 30_000);

  it("allows the sanctioned entry points", async () => {
    expect(
      await restricted('import { withOwnerScope } from "@/server/db";', "src/features/auth/probe.ts"),
    ).toEqual([]);
    expect(
      await restricted('import { ledger } from "@/server/ledger";', "src/features/auth/probe.ts"),
    ).toEqual([]);
    expect(
      await restricted('import { createServerClient } from "@supabase/ssr";', "src/server/auth/supabase/probe.ts"),
    ).toEqual([]);
    expect(
      await restricted('import { createServerClient } from "@supabase/ssr";', "src/proxy.ts"),
    ).toEqual([]);
    expect(
      await restricted('import { PrismaPg } from "@prisma/adapter-pg";', "src/server/db/probe.ts"),
    ).toEqual([]);
  }, 30_000);

  it("keeps the domain rule in force for domain files", async () => {
    expect(
      await restricted('import { PrismaClient } from "@prisma/client";', "src/domain/probe.ts"),
    ).not.toHaveLength(0);
    expect(await restricted('import pg from "pg";', "src/domain/probe.ts")).not.toHaveLength(0);
  }, 30_000);
});
