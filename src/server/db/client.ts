import { PrismaPg } from "@prisma/adapter-pg";

import { getDatabaseEnv } from "@/server/env";

import { PrismaClient } from "./generated/client";

export function createPrismaClient(
  connectionString: string,
  maxConnections: number,
): PrismaClient {
  const adapter = new PrismaPg({
    connectionString,
    max: maxConnections,
    idleTimeoutMillis: 10_000,
  });
  return new PrismaClient({ adapter });
}

const globalCache = globalThis as unknown as { finoraPrisma?: PrismaClient };

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
