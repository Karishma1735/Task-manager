export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { assertProductionConfig, seedFromEnvIfMissing, failStartup } = await import("./lib/startup");
  try {
    assertProductionConfig(); // production only: DATA_DIR / SESSION_SECRET present, no test-only settings
    if (process.env.NODE_ENV === "production") {
      // Migrate (via getDb) and create the first accounts. Idempotent: never overwrites existing data.
      const { getDb } = await import("./db");
      const report = await seedFromEnvIfMissing(getDb());
      console.log(
        `[startup] database ready; owner ${report.ownerCreated ? "created" : "unchanged"}, reviewer ${report.reviewerCreated ? "created" : "unchanged"}` +
          (report.skipped ? ` (${report.skipped})` : ""),
      );
    }
  } catch (e) {
    failStartup(e);
  }
  const { startOutboxSweeper } = await import("./lib/outbox-sweeper");
  startOutboxSweeper();
}
