import { randomBytes } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";

// Throwaway credentials for the throwaway e2e database — generated per run, never committed.
// Set in process.env during config load so the web server and the test workers share them.
process.env.E2E_OWNER_EMAIL ??= "owner@e2e.invalid";
process.env.E2E_REVIEWER_EMAIL ??= "reviewer@e2e.invalid";
process.env.E2E_OWNER_PASSWORD ??= randomBytes(18).toString("base64url");
process.env.E2E_REVIEWER_PASSWORD ??= randomBytes(18).toString("base64url");

const PORT = 3100;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "off",
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `sh -c "rm -rf .e2e && npm run db:setup && npx next build && npx next start -p ${PORT}"`,
    url: `http://localhost:${PORT}/login`,
    timeout: 300_000,
    reuseExistingServer: false,
    env: {
      DATABASE_PATH: ".e2e/e2e.db",
      SESSION_SECRET: randomBytes(32).toString("hex"),
      OWNER_EMAIL: process.env.E2E_OWNER_EMAIL!,
      OWNER_PASSWORD: process.env.E2E_OWNER_PASSWORD!,
      REVIEWER_EMAIL: process.env.E2E_REVIEWER_EMAIL!,
      REVIEWER_PASSWORD: process.env.E2E_REVIEWER_PASSWORD!,
      // Pin the *server* clock to Monday 9 Nov 2026, 09:30 IST so the 11:00 deadline can't make runs flaky.
      VL_TEST_NOW: "2026-11-09T04:00:00.000Z",
      VL_ALLOW_TEST_CLOCK: "1",
      BCRYPT_COST: "4",
    },
  },
});
