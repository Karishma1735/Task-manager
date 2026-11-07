import { ok, route } from "@/lib/api";
import { parseId } from "@/lib/ids";
import { closeOutcome } from "@/lib/ledger";

export const POST = route(["owner"], async ({ db, actor, now, params, json }) =>
  ok(closeOutcome(db, actor, parseId(params.id), await json(), now)),
);
