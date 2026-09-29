import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the critical quick-entry E2E flow (Plan 2 Task 16).
 * Runs against the local dev server + local Supabase stack only — never a
 * deployed environment. `reuseExistingServer: true` lets a dev server the
 * operator already has running stay up (faster local iteration); CI/fresh
 * runs get one started for them.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
