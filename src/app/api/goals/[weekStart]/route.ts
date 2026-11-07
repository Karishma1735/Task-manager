import { ok, route } from "@/lib/api";
import { getGoals, putGoals } from "@/lib/ledger";

export const GET = route(["owner", "reviewer"], ({ db, params }) => ok({ goals: getGoals(db, params.weekStart!) }));

// Owner and reviewers may edit goals; every change is audited with the actor.
export const PUT = route(["owner", "reviewer"], async ({ db, actor, now, params, json }) =>
  ok({ goals: putGoals(db, actor, params.weekStart!, await json(), now) }),
);
