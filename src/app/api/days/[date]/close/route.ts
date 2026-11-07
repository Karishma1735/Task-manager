import { ok, route } from "@/lib/api";
import { closeDay } from "@/lib/ledger";

export const POST = route(["owner"], async ({ db, actor, now, params, json }) =>
  ok({ day: closeDay(db, actor, params.date!, await json(), now) }),
);
