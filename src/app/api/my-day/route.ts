import { ok, route } from "@/lib/api";
import { getMyDay } from "@/lib/ledger";

export const GET = route(["owner"], ({ db, now, req }) => {
  const date = new URL(req.url).searchParams.get("date") ?? undefined;
  return ok(getMyDay(db, date, now));
});
