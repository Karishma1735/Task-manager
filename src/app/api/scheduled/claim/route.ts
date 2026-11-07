import { ok, tokenRoute } from "@/lib/api";
import { claimScheduled } from "@/lib/scheduled";

/** A flow asks "may I send this reminder/digest?". At most one caller per (kind, date) gets send:true. */
export const POST = tokenRoute(async ({ db, now, json }) => ok(claimScheduled(db, await json(), now)));
