import { PrismaPg } from "@prisma/adapter-pg";

import { getDatabaseEnv } from "@/server/env";

import { PrismaClient } from "./generated/client";

/**
 * Builds a Prisma client for the restricted finora_app role. Only modules in
 * src/server/db may import this file (enforced by ESLint); the rest of the app
 * reaches the database through the scoped helpers in ./index.ts.
 */
export function createPrismaClient(
  connectionString: string,
  maxConnections: number,
): PrismaClient {
  const adapter = new PrismaPg({
    connectionString,
    max: maxConnections,
    // Release idle connections quickly; serverless instances are short-lived.
    idleTimeoutMillis: 10_000,
  });
  return new PrismaClient({ adapter });
}

const globalCache = globalThis as unknown as { finoraPrisma?: PrismaClient };

/** Process-wide client (reused across hot reloads in development). */
export function getPrismaClient(): PrismaClient {
  if (!globalCache.finoraPrisma) {
    const env = getDatabaseEnv();
    globalCache.finoraPrisma = createPrismaClient(
      env.DATABASE_URL,
      env.DATABASE_POOL_MAX,
    );
  }
  return globalCache.finoraPrisma;
}
