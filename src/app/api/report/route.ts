import { ok, route, tokenRoute } from "@/lib/api";
import { buildDigest } from "@/lib/digest";
import { defaultCfg } from "@/lib/ledger";
import { getReport } from "@/lib/report";
import { hasTokenHeader } from "@/lib/scheduled-auth";
import { localDate } from "@/lib/time";
import type { Db } from "@/db";

function respond(db: Db, req: Request, now: Date) {
  const params = new URL(req.url).searchParams;
  const cfg = defaultCfg();
  const report = getReport(db, params.get("week") ?? undefined, now, cfg);
  if (params.get("digest") === "1") {
    return ok({ ...report, digest: buildDigest(report, { now, tz: cfg.tz, today: localDate(now, cfg.tz) }) });
  }
  return ok(report);
}

const asSession = route(["owner", "reviewer"], ({ db, now, req }) => respond(db, req, now));
const asScheduler = tokenRoute(({ db, now, req }) => respond(db, req, now));

/**
 * Owner and reviewers read it with their session. viaSocket's scheduled flows read it with the
 * REMINDER_TOKEN header (add `&digest=1` for the ready-made weekly digest text).
 */
export const GET = (req: Request) => (hasTokenHeader(req) ? asScheduler(req) : asSession(req));
