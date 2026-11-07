export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startOutboxSweeper } = await import("./lib/outbox-sweeper");
    startOutboxSweeper();
  }
}
