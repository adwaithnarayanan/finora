import { defineConfig } from "prisma/config";

/**
 * Prisma CLI configuration. The CLI (migrate, db execute, studio) connects with
 * the privileged MIGRATION_DATABASE_URL; the application never does: it uses
 * DATABASE_URL as the restricted `finora_app` role (src/server/db/client.ts).
 *
 * The URL is optional here so `prisma generate` works without a database.
 * Use the npm `db:*` scripts, which supply it and refuse non-local targets for
 * destructive operations.
 */
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env["MIGRATION_DATABASE_URL"] ?? "",
    // Only needed to diff the migrations directory (`npm run db:local:drift`).
    shadowDatabaseUrl: process.env["SHADOW_DATABASE_URL"],
  },
});
