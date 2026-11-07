import { getDb } from "@/db";
import { systemClock } from "@/lib/clock";
import { processDue } from "@/lib/outbox";

declare global {
  var __vlSweeper: ReturnType<typeof setInterval> | undefined;
}

/** Picks up retries that came due while no request was in flight. */
export function startOutboxSweeper(): void {
  if (process.env.VL_DISABLE_OUTBOX === "1" || globalThis.__vlSweeper) return;
  globalThis.__vlSweeper = setInterval(() => {
    processDue(getDb(), systemClock).catch(() => console.error("[outbox] sweeper pass failed"));
  }, 30_000);
  globalThis.__vlSweeper.unref?.();
}
