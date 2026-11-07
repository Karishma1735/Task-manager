import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { users } from "@/db/schema";
import { writeAudit } from "@/lib/audit";
import { hashPassword } from "@/lib/auth";

export interface SeedAccount {
  name: string;
  email: string;
  password: string;
  role: "owner" | "reviewer";
}

/** Creates accounts that don't exist yet. Existing accounts are left alone unless resetPasswords is set. */
export async function seedUsers(
  db: Db,
  accounts: SeedAccount[],
  now: Date,
  opts: { resetPasswords?: boolean } = {},
): Promise<{ created: string[]; updated: string[]; skipped: string[] }> {
  const result = { created: [] as string[], updated: [] as string[], skipped: [] as string[] };
  for (const a of accounts) {
    const email = a.email.trim().toLowerCase();
    if (a.password.length < 12) throw new Error(`Password for ${a.role} must be at least 12 characters`);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error(`Invalid ${a.role} email`);
    const hash = await hashPassword(a.password);
    const existing = db.select().from(users).where(eq(users.email, email)).get();
    if (!existing) {
      db.transaction((tx) => {
        const row = tx
          .insert(users)
          .values({ name: a.name, email, passwordHash: hash, role: a.role, createdAt: now.toISOString() })
          .returning({ id: users.id })
          .get();
        writeAudit(tx, { at: now, actorId: null, action: "user.seed", entity: "user", entityId: row.id, after: { email, role: a.role } });
      });
      result.created.push(email);
    } else if (opts.resetPasswords) {
      db.transaction((tx) => {
        tx.update(users).set({ passwordHash: hash, name: a.name }).where(eq(users.id, existing.id)).run();
        writeAudit(tx, { at: now, actorId: null, action: "user.password_reset", entity: "user", entityId: existing.id });
      });
      result.updated.push(email);
    } else {
      result.skipped.push(email);
    }
  }
  return result;
}

export function accountsFromEnv(env: NodeJS.ProcessEnv = process.env): SeedAccount[] {
  const need = ["OWNER_EMAIL", "OWNER_PASSWORD", "REVIEWER_EMAIL", "REVIEWER_PASSWORD"] as const;
  const missing = need.filter((k) => !env[k]);
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  return [
    { name: env.OWNER_NAME || "Owner", email: env.OWNER_EMAIL!, password: env.OWNER_PASSWORD!, role: "owner" },
    { name: env.REVIEWER_NAME || "Reviewer", email: env.REVIEWER_EMAIL!, password: env.REVIEWER_PASSWORD!, role: "reviewer" },
  ];
}
