import { ok, route } from "@/lib/api";
import { logUnplanned } from "@/lib/ledger";

export const POST = route(["owner"], async ({ db, actor, now, params, json }) =>
  ok({ outcome: logUnplanned(db, actor, params.date!, await json(), now) }, 201),
);
