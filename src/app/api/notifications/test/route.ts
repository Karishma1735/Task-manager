import { z } from "zod";
import { ok, route } from "@/lib/api";
import { queueTestEvent } from "@/lib/outbox";
import { parseBody } from "@/lib/validate";
import { EVENT_TYPES } from "@/lib/viasocket";

const schema = z.object({ type: z.enum(EVENT_TYPES as [string, ...string[]]) }).strict();

/** Owner only. Queues one clearly-labelled test event (`is_test: true`) for the chosen flow. */
export const POST = route(["owner"], async ({ db, actor, now, json }) => {
  const { type } = parseBody(schema, await json());
  const id = queueTestEvent(db, actor, type as (typeof EVENT_TYPES)[number], now);
  return ok({ id }, 201);
});
