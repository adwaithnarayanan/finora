import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: {
      "server-only": fileURLToPath(new URL("./tests/support/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}", "tests/unit/**/*.test.{ts,tsx}"],
    setupFiles: ["./vitest.setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/domain/**/*.ts", "src/server/**/*.ts", "src/features/shared/*.ts"],
      exclude: [
        "**/*.test.ts",
        "**/index.ts",
        "src/server/db/generated/**",
        // Exercised by the integration suite against real Postgres/Supabase.
        "src/server/db/**",
        "src/server/auth/session.ts",
        "src/server/auth/supabase/server-client.ts",
        "src/server/ledger/service.ts",
        "src/server/finance/service.ts",
        "**/*.test-helpers.ts",
      ],
      thresholds: {
        "src/domain/finance/**": {
          branches: 95,
          functions: 100,
          lines: 95,
          statements: 95,
        },
        "src/domain/ledger/**": {
          branches: 95,
          functions: 100,
          lines: 95,
          statements: 95,
        },
        "src/domain/money/**": {
          branches: 95,
          functions: 100,
          lines: 95,
          statements: 95,
        },
      },
    },
  },
});
