import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

type User = { email: string; password: string; userId: string };

export type E2EUsers = {
  /** Provisioned through the real operator workflow (prepare, set-password, complete). */
  owner: User & { ownerId: string };
  /** A second provisioned owner whose owner row is disabled. */
  inactive: User & { ownerId: string };
  /** Confirmed, with a password, but never approved or mapped. */
  stranger: User;
  /** Approved by email, but no owner mapping (an interrupted provisioning). */
  unmapped: User;
  /** Has a password but never confirmed its email. */
  unverified: User;
};

export const USERS_FILE = path.join(process.cwd(), "test-results", ".e2e-users.json");

/** Users created by global-setup for this run (local stack only). */
export function e2eUsers(): E2EUsers {
  return JSON.parse(readFileSync(USERS_FILE, "utf8")) as E2EUsers;
}

export type ProvisionedOwner = User & { ownerId: string };

/** One JSON line per owner a test provisioned for itself (see support/owners.ts). */
export const EXTRA_OWNERS_FILE = path.join(process.cwd(), "test-results", ".e2e-extra-owners.jsonl");

export function extraOwners(): ProvisionedOwner[] {
  if (!existsSync(EXTRA_OWNERS_FILE)) return [];
  return readFileSync(EXTRA_OWNERS_FILE, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as ProvisionedOwner);
}
