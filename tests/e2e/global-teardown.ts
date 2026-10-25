import { existsSync, rmSync } from "node:fs";

import { EXTRA_OWNERS_FILE, USERS_FILE, e2eUsers, extraOwners } from "./support/fixtures";
import { removeTestUsers } from "./support/owners";

/**
 * Removes exactly the users this run created: global-setup's (USERS_FILE) and
 * the owners tests provisioned for themselves (EXTRA_OWNERS_FILE). Tests
 * remove their own owners as they finish; this catches any they could not.
 */
export default async function globalTeardown() {
  const users = existsSync(USERS_FILE) ? Object.values(e2eUsers()) : [];
  const extras = extraOwners();
  if (users.length === 0 && extras.length === 0) return;
  await removeTestUsers([...users, ...extras]);
  rmSync(USERS_FILE, { force: true });
  rmSync(EXTRA_OWNERS_FILE, { force: true });
}
