import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  // e2e/manual/ hits real sites; opt-in only (npm run token-table).
  testIgnore: process.env.TABAGENT_MANUAL ? [] : ["**/manual/**"],
  timeout: 120_000,
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  retries: 0,
});
