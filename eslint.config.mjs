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

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  domainBoundaryRule,
  globalIgnores([
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
