import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * The domain layer is pure TypeScript: no framework, persistence, auth provider,
 * Node built-ins, or app-layer modules. Exported so the rule itself is tested.
 */
export const domainBoundaryRule = {
  files: ["src/domain/**/*.{ts,tsx}"],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: [
              "next",
              "next/*",
              "react",
              "react/*",
              "react-dom",
              "react-dom/*",
              "@prisma/*",
              "prisma",
              "pg",
              "@supabase/*",
              "node:*",
            ],
            message:
              "src/domain must stay framework- and infrastructure-free (see docs/adr/0001-architecture.md).",
          },
          {
            group: ["@/*", "!@/domain", "!@/domain/**"],
            message:
              "src/domain may only import from src/domain; inject other dependencies through interfaces.",
          },
          {
            group: [
              "**/app",
              "**/app/**",
              "**/server",
              "**/server/**",
              "**/components",
              "**/components/**",
              "**/features/**",
              "**/lib",
              "**/lib/**",
              "**/offline/**",
            ],
            message:
              "src/domain may not reach into app, server, UI or infrastructure modules.",
          },
        ],
      },
    ],
    "no-restricted-syntax": [
      "error",
      {
        selector: "ImportExpression",
        message: "Dynamic import() is not allowed in src/domain; it bypasses the import boundary.",
      },
      {
        selector: "CallExpression[callee.name='require']",
        message: "require() is not allowed in src/domain; it bypasses the import boundary.",
      },
    ],
  },
};

const prismaInternals = {
  group: [
    "@prisma/*",
    "pg",
    "@/server/db/client",
    "@/server/db/scope",
    "@/server/db/owner-directory",
    "@/server/db/ledger-store",
    "@/server/db/finance-store",
    "@/server/db/generated",
    "@/server/db/generated/**",
    "**/db/generated",
    "**/db/generated/**",
  ],
  message:
    "Use the scoped helpers from @/server/db; the Prisma client stays inside src/server/db (docs/adr/0004).",
};

const supabaseSdk = {
  group: ["@supabase/*"],
  message:
    "Supabase SDKs are confined to src/server/auth/supabase and src/proxy.ts (docs/adr/0003).",
};

/**
 * Infrastructure boundaries outside the domain layer. Exported for tests.
 * Later configs override earlier ones per file, so the domain rule comes last.
 */
export const infrastructureBoundaryRules = [
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/server/db/**", "src/server/auth/supabase/**", "src/proxy.ts", "src/domain/**"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [prismaInternals, supabaseSdk] }],
    },
  },
  {
    files: ["src/server/auth/supabase/**/*.{ts,tsx}", "src/proxy.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [prismaInternals] }],
    },
  },
  {
    files: ["src/server/db/**/*.{ts,tsx}"],
    ignores: ["src/server/db/generated/**"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [supabaseSdk] }],
    },
  },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  ...infrastructureBoundaryRules,
  domainBoundaryRule,
  globalIgnores([
    "src/server/db/generated/**",
    ".next/**",
    "out/**",
    "build/**",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
