import { getDb } from "@/db";
import { systemClock } from "@/lib/clock";
import { getMyDay } from "@/lib/ledger";
import { requireUserPage } from "@/lib/session";
import { MyDay } from "./MyDay";

export const dynamic = "force-dynamic";

export default async function MyDayPage() {
  const user = await requireUserPage("owner");
  const initial = getMyDay(getDb(), undefined, systemClock());
  return <MyDay initial={JSON.parse(JSON.stringify(initial))} userName={user.name} />;
}
