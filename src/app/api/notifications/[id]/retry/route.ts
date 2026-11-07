import { ok, route } from "@/lib/api";
import { parseId } from "@/lib/ids";
import { retryNotification } from "@/lib/outbox";

export const POST = route(["owner"], ({ db, actor, now, params }) => {
  const n = retryNotification(db, actor, parseId(params.id), now);
  return ok({ id: n.id, status: n.status });
});
