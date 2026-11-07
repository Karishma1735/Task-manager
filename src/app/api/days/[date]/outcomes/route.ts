import { ok, route } from "@/lib/api";
import { addOutcome } from "@/lib/ledger";

export const POST = route(["owner"], async ({ db, actor, now, params, json }) =>
  ok({ outcome: addOutcome(db, actor, params.date!, await json(), now) }, 201),
);
