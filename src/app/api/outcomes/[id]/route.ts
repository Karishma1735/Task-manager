import { ok, route } from "@/lib/api";
import { parseId } from "@/lib/ids";
import { deleteDraftOutcome, updateDraftOutcome } from "@/lib/ledger";

// Drafts only — the service refuses once the day is committed.
export const PATCH = route(["owner"], async ({ db, actor, now, params, json }) =>
  ok({ outcome: updateDraftOutcome(db, actor, parseId(params.id), await json(), now) }),
);

export const DELETE = route(["owner"], ({ db, actor, now, params }) => {
  deleteDraftOutcome(db, actor, parseId(params.id), now);
  return ok({ deleted: true });
});
