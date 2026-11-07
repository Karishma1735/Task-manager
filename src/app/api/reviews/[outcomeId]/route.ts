import { ok, route } from "@/lib/api";
import { parseId } from "@/lib/ids";
import { putReview } from "@/lib/reviews";

// Reviewers only: the owner gets 403 and can never change a score.
export const PUT = route(["reviewer"], async ({ db, actor, now, params, json }) =>
  ok(putReview(db, actor, parseId(params.outcomeId), await json(), now)),
);
