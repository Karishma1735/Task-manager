import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { getSessionUser, SESSION_COOKIE, type Actor, type Role } from "@/lib/auth";
import { systemClock } from "@/lib/clock";

/** For server components: the signed-in user, or null. */
export async function currentUser(): Promise<Actor | null> {
  const jar = await cookies();
  return getSessionUser(getDb(), jar.get(SESSION_COOKIE)?.value, systemClock());
}

export async function requireUserPage(role?: Role): Promise<Actor> {
  const u = await currentUser();
  if (!u) redirect("/login");
  if (role && u.role !== role) redirect(u.role === "owner" ? "/my-day" : "/report");
  return u;
}
