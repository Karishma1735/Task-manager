import { ok, route } from "@/lib/api";
import { defaultCfg, getGoals } from "@/lib/ledger";
import { localDate, weekStartOf } from "@/lib/time";

/** Current week's goals. */
export const GET = route(["owner", "reviewer"], ({ db, now }) => {
  const weekStart = weekStartOf(localDate(now, defaultCfg().tz));
  return ok({ weekStart, goals: getGoals(db, weekStart) });
});
