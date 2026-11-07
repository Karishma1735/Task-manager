import { ok, tokenRoute } from "@/lib/api";
import { confirmScheduled } from "@/lib/scheduled";

/** A flow reports whether its send succeeded (ok) or failed (ok:false + short error code). */
export const POST = tokenRoute(async ({ db, now, json }) => ok(confirmScheduled(db, await json(), now)));
