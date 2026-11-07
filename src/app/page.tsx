import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function Home() {
  const u = await currentUser();
  if (!u) redirect("/login");
  redirect(u.role === "owner" ? "/my-day" : "/report");
}
