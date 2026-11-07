import { ok, tokenRoute } from "@/lib/api";
import { getStatus } from "@/lib/scheduled";

/** Called by viaSocket's scheduled flows. Requires the REMINDER_TOKEN header. Read-only; reveals no work content. */
export const GET = tokenRoute(({ db, now, req }) => ok(getStatus(db, new URL(req.url).searchParams.get("date"), now)));
