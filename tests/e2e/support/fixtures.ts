import { readFileSync } from "node:fs";
import path from "node:path";

export type E2EUsers = {
  owner: { email: string; password: string; userId: string; ownerId: string };
  stranger: { email: string; password: string; userId: string };
};

export const USERS_FILE = path.join(process.cwd(), "test-results", ".e2e-users.json");

/** Users created by global-setup for this run (local stack only). */
export function e2eUsers(): E2EUsers {
  return JSON.parse(readFileSync(USERS_FILE, "utf8")) as E2EUsers;
}
