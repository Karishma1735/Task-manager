import { ok, route } from "@/lib/api";
import { commitDay } from "@/lib/ledger";

export const POST = route(["owner"], ({ db, actor, now, params }) => ok({ day: commitDay(db, actor, params.date!, now) }));
