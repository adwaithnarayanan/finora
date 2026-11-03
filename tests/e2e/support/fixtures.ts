import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

type User = { email: string; password: string; userId: string };

export type E2EUsers = {
  owner: User & { ownerId: string };
  inactive: User & { ownerId: string };
  stranger: User;
  unmapped: User;
  unverified: User;
};

export const USERS_FILE = path.join(
  process.cwd(),
  "test-results",
  ".e2e-users.json",
);

export function e2eUsers(): E2EUsers {
  return JSON.parse(readFileSync(USERS_FILE, "utf8")) as E2EUsers;
}

export type ProvisionedOwner = User & { ownerId: string };

export const EXTRA_OWNERS_FILE = path.join(
  process.cwd(),
  "test-results",
  ".e2e-extra-owners.jsonl",
);

export function extraOwners(): ProvisionedOwner[] {
  if (!existsSync(EXTRA_OWNERS_FILE)) return [];
  return readFileSync(EXTRA_OWNERS_FILE, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as ProvisionedOwner);
}
