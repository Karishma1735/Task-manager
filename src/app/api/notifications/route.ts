import { ok, route } from "@/lib/api";
import { defaultCfg } from "@/lib/ledger";
import { listNotifications } from "@/lib/outbox";
import { webhookHealth } from "@/lib/viasocket";

/** Owner only. Delivery log + webhook health. Never returns payloads, proof links, URLs or tokens. */
export const GET = route(["owner"], ({ db }) => {
  const cfg = defaultCfg();
  return ok({ notifications: listNotifications(db), health: webhookHealth(), commitByHour: cfg.commitByHour, tz: cfg.tz });
});
