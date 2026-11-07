import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    env: { BCRYPT_COST: "4", SESSION_SECRET: "test-secret-test-secret-test-secret-0123", APP_TZ: "Asia/Kolkata", COMMIT_BY_HOUR: "11", VL_DISABLE_OUTBOX: "1" },
  },
});
