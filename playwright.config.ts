import { randomBytes } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";

// Throwaway credentials for the throwaway e2e database — generated per run, never committed.
// Set in process.env during config load so the web server and the test workers share them.
process.env.E2E_OWNER_EMAIL ??= "owner@e2e.invalid";
process.env.E2E_REVIEWER_EMAIL ??= "reviewer@e2e.invalid";
process.env.E2E_OWNER_PASSWORD ??= randomBytes(18).toString("base64url");
process.env.E2E_REVIEWER_PASSWORD ??= randomBytes(18).toString("base64url");

process.env.E2E_HOOK_TOKEN ??= randomBytes(18).toString("base64url");
process.env.E2E_REMINDER_TOKEN ??= randomBytes(24).toString("base64url");

const PORT = 3100;
const MOCK_PORT = 3101;

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
  webServer: [
    {
      command: "node e2e/mock-webhook.mjs",
      url: `http://localhost:${MOCK_PORT}/__ready`,
      reuseExistingServer: false,
      env: { MOCK_PORT: String(MOCK_PORT), MOCK_EXPECTED_TOKEN: process.env.E2E_HOOK_TOKEN! },
    },
    {
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
      VL_E2E_ALLOW: "1", // the only way a production build may use a test clock / a throwaway DB path
      BCRYPT_COST: "4",
      // viaSocket webhooks point at the local mock — the e2e run never contacts the real service.
      VIASOCKET_HOOK_COMMIT: `http://localhost:${MOCK_PORT}/hook/commit`,
      VIASOCKET_HOOK_REPORT: `http://localhost:${MOCK_PORT}/hook/daily_report`,
      VIASOCKET_HOOK_REVIEW: `http://localhost:${MOCK_PORT}/hook/review`,
      VIASOCKET_SHARED_TOKEN: process.env.E2E_HOOK_TOKEN!,
      VIASOCKET_ALLOW_ANY_HOST: "1",
      OUTBOX_RETRY_DELAYS_MIN: "0,0,0",
      REMINDER_TOKEN: process.env.E2E_REMINDER_TOKEN!,
      SCHEDULED_REMINDERS_ENABLED: "1", // off by default in real configs; on here (no destinations are wired in e2e)
      APP_BASE_URL: `http://localhost:${PORT}`,
    },
  },
  ],
});
