/**
 * Production startup: validate configuration, migrate the database and create the first accounts.
 * Idempotent and non-destructive — it never overwrites, resets or deletes anything that already exists.
 */
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { users } from "@/db/schema";
import { accountsFromEnv, seedUsers } from "@/lib/seed";

/** Settings that must never be present in a real production process. */
const TEST_ONLY_VARS = ["VL_TEST_NOW", "VL_ALLOW_TEST_CLOCK", "VIASOCKET_ALLOW_ANY_HOST"];

export function productionConfigProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.NODE_ENV !== "production") return [];
  const problems: string[] = [];
  if (env.VL_E2E_ALLOW !== "1") {
    if (!env.DATA_DIR?.trim()) problems.push("DATA_DIR is not set (the database must live under it)");
    for (const k of TEST_ONLY_VARS) if (env[k]) problems.push(`${k} is a test-only setting and must not be set in production`);
  }
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) problems.push("SESSION_SECRET must be set to at least 32 characters");
  if (env.SCHEDULED_REMINDERS_ENABLED === "1" && (env.REMINDER_TOKEN?.trim().length ?? 0) < 16) {
    problems.push("SCHEDULED_REMINDERS_ENABLED=1 needs REMINDER_TOKEN (at least 16 characters)");
  }
  return problems;
}

/** Throws (so the app visibly refuses to start) rather than running with an unsafe configuration. */
export function assertProductionConfig(env: NodeJS.ProcessEnv = process.env): void {
  const problems = productionConfigProblems(env);
  if (problems.length) throw new Error(`Refusing to start — configuration problems: ${problems.join("; ")}`);
}

export interface SeedReport {
  ownerCreated: boolean;
  reviewerCreated: boolean;
  skipped: string | null;
}

/**
 * Creates the owner (only when no owner exists at all) and the reviewer (when that email is missing) from
 * the OWNER_ and REVIEWER_ variables. Existing accounts and passwords are never touched, so a redeploy or a
 * restart can never overwrite production data.
 */
export async function seedFromEnvIfMissing(db: Db, env: NodeJS.ProcessEnv = process.env, now = new Date()): Promise<SeedReport> {
  let accounts;
  try {
    accounts = accountsFromEnv(env);
  } catch {
    return { ownerCreated: false, reviewerCreated: false, skipped: "the OWNER_ and REVIEWER_ variables are not all set" };
  }
  const report: SeedReport = { ownerCreated: false, reviewerCreated: false, skipped: null };
  const ownerExists = Boolean(db.select({ id: users.id }).from(users).where(eq(users.role, "owner")).limit(1).get());
  const toCreate = accounts.filter((a) => (a.role === "owner" ? !ownerExists : true));
  if (toCreate.length) {
    const res = await seedUsers(db, toCreate, now); // creates only emails that don't exist; never resets passwords
    const created = new Set(res.created);
    report.ownerCreated = accounts.some((a) => a.role === "owner" && created.has(a.email.trim().toLowerCase()));
    report.reviewerCreated = accounts.some((a) => a.role === "reviewer" && created.has(a.email.trim().toLowerCase()));
  }
  return report;
}

/**
 * Exit instead of serving errors, so the host shows "crashed" with this reason in its logs.
 * The message names the problem only; it never contains a secret value.
 */
export function failStartup(e: unknown): never {
  console.error(`[startup] ${e instanceof Error ? e.message : "startup failed"}`);
  process.exit(1);
}
