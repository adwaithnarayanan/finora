import { execFileSync } from "node:child_process";

import type { TestProject } from "vitest/node";

import { readLocalSupabase } from "../../scripts/lib/local-supabase.mjs";

declare module "vitest" {
  export interface ProvidedContext {
    local: ReturnType<typeof readLocalSupabase>;
  }
}

export default function setup(project: TestProject) {
  const local = readLocalSupabase();
  execFileSync("node", ["scripts/db/local.mjs", "setup"], { stdio: "ignore" });
  project.provide("local", local);
}
