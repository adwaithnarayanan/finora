import { existsSync, rmSync } from "node:fs";

import {
  EXTRA_OWNERS_FILE,
  USERS_FILE,
  e2eUsers,
  extraOwners,
} from "./support/fixtures";
import { removeTestUsers } from "./support/owners";

export default async function globalTeardown() {
  const users = existsSync(USERS_FILE) ? Object.values(e2eUsers()) : [];
  const extras = extraOwners();
  if (users.length === 0 && extras.length === 0) return;
  await removeTestUsers([...users, ...extras]);
  rmSync(USERS_FILE, { force: true });
  rmSync(EXTRA_OWNERS_FILE, { force: true });
}
