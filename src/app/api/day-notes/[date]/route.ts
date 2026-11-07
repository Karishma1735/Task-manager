import { ok, route } from "@/lib/api";
import { putDayNote } from "@/lib/reviews";

export const PUT = route(["reviewer"], async ({ db, actor, now, params, json }) =>
  ok(putDayNote(db, actor, params.date!, await json(), now)),
);
