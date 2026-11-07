import { ok, route } from "@/lib/api";
import { defaultCfg } from "@/lib/ledger";
import { getReport } from "@/lib/report";

/** Owner and reviewers can read the report; the six measures arrive already computed. */
export const GET = route(["owner", "reviewer"], ({ db, now, req }) => {
  const week = new URL(req.url).searchParams.get("week") ?? undefined;
  return ok(getReport(db, week, now, defaultCfg()));
});
