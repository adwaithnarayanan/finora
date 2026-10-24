import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * Lints in-memory source as if it lived in src/domain, using the real project
 * config, so no invalid file ever exists on disk.
 */
const eslint = new ESLint({ cwd: process.cwd() });

async function restrictedImportErrors(source: string, filePath: string) {
  const [result] = await eslint.lintText(source, { filePath });
  return (result?.messages ?? []).filter(
    (m) =>
      m.ruleId === "no-restricted-imports" ||
      m.ruleId === "no-restricted-syntax",
  );
}

const DOMAIN_FILE = "src/domain/__boundary_probe__.ts";

describe("domain import boundary", () => {
  it.each([
    'import { redirect } from "next/navigation";',
    'import Link from "next/link";',
    'import { useState } from "react";',
    'import { createRoot } from "react-dom/client";',
    'import { PrismaClient } from "@prisma/client";',
    'import { createClient } from "@supabase/supabase-js";',
    'import { readFileSync } from "node:fs";',
    'import { getServerEnv } from "@/server/env";',
    'import { Button } from "@/components/ui/button";',
    'import { cn } from "@/lib/utils";',
    'import { getServerEnv } from "../server/env";',
    'import { getServerEnv } from "../../server/env";',
    'import RootLayout from "../app/layout";',
    'export { getServerEnv } from "@/server/env";',
    'const env = await import("@/server/env");',
    'const prisma = require("@prisma/client");',
  ])("rejects %s", async (source) => {
    const errors = await restrictedImportErrors(
      `${source}\nexport {};\n`,
      DOMAIN_FILE,
    );
    expect(errors.length).toBeGreaterThan(0);
  }, 30_000);

  it.each([
    'import { Money } from "./money";',
    'import { Money } from "@/domain/money";',
    'import { Money } from "../domain/money";',
    'import { z } from "zod";',
  ])("allows %s", async (source) => {
    const errors = await restrictedImportErrors(
      `${source}\nexport {};\n`,
      DOMAIN_FILE,
    );
    expect(errors).toEqual([]);
  }, 30_000);

  it("does not restrict code outside src/domain", async () => {
    const errors = await restrictedImportErrors(
      'import { getServerEnv } from "@/server/env";\nexport {};\n',
      "src/app/__boundary_probe__.ts",
    );
    expect(errors).toEqual([]);
  }, 30_000);
});
