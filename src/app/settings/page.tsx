import { getDb } from "@/db";
import { defaultCfg } from "@/lib/ledger";
import { listNotifications } from "@/lib/outbox";
import { requireUserPage } from "@/lib/session";
import { webhookHealth } from "@/lib/viasocket";
import { Settings } from "./Settings";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  await requireUserPage("owner");
  const cfg = defaultCfg();
  const initial = { notifications: listNotifications(getDb()), health: webhookHealth(), commitByHour: cfg.commitByHour, tz: cfg.tz };
  return <Settings initial={JSON.parse(JSON.stringify(initial))} />;
}
