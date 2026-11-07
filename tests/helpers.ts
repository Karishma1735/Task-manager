import { createTestDb, type Db } from "@/db";
import { hashPassword, type Actor } from "@/lib/auth";
import { users } from "@/db/schema";

export const TZ = "Asia/Kolkata";
/** Monday 9 Nov 2026, 09:30 IST. */
export const MON_0930 = new Date("2026-11-09T04:00:00.000Z");
export const iso = (s: string) => new Date(s);

export interface World {
  db: Db;
  owner: Actor;
  reviewer: Actor;
}

export async function makeWorld(): Promise<World> {
  const db = createTestDb();
  const hash = await hashPassword("correct-horse-battery", 4);
  const now = new Date("2026-01-01T00:00:00Z").toISOString();
  const o = db.insert(users).values({ name: "Olive Owner", email: "owner@example.test", passwordHash: hash, role: "owner", createdAt: now }).returning().get();
  const r = db.insert(users).values({ name: "Ravi Reviewer", email: "reviewer@example.test", passwordHash: hash, role: "reviewer", createdAt: now }).returning().get();
  return {
    db,
    owner: { id: o.id, name: o.name, email: o.email, role: "owner" },
    reviewer: { id: r.id, name: r.name, email: r.email, role: "reviewer" },
  };
}

/** Drizzle wraps driver errors; the SQLite message lives on `cause`. */
export function dbErrorMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    const err = e as Error & { cause?: Error };
    return `${err.message} ${err.cause?.message ?? ""}`;
  }
  return "";
}
