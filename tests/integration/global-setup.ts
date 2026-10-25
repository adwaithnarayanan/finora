import { execFileSync } from "node:child_process";

import type { TestProject } from "vitest/node";

import { readLocalSupabase } from "../../scripts/lib/local-supabase.mjs";

declare module "vitest" {
  export interface ProvidedContext {
    local: ReturnType<typeof readLocalSupabase>;
  }
}

export default function setup(project: TestProject) {
  // Throws (and so fails the run) unless the local stack is up and loopback-only.
  const local = readLocalSupabase();
  // Idempotent: applies pending migrations and enables the local app login.
  execFileSync("node", ["scripts/db/local.mjs", "setup"], { stdio: "ignore" });
  project.provide("local", local);
}
