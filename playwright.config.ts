import { defineConfig, devices } from "@playwright/test";

import {
  localAppEnv,
  readLocalSupabase,
} from "./scripts/lib/local-supabase.mjs";

const PORT = Number(process.env.PORT ?? 3100);
const baseURL = `http://localhost:${PORT}`;

const local = readLocalSupabase();

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  globalTeardown: "./tests/e2e/global-teardown.ts",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 7"] },
      testMatch: /layout\.spec\.ts/,
    },
  ],
  webServer: {
    command: `npm run start -- --port ${PORT} --hostname localhost`,
    url: `${baseURL}/login`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { ...localAppEnv(local, baseURL), NODE_ENV: "production" },
  },
});
