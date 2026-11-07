/** Server-only configuration. Never import from client components. */
import { randomBytes } from "node:crypto";
import path from "node:path";

export function appTz(): string {
  return process.env.APP_TZ || "Asia/Kolkata";
}

export function commitByHour(): number {
  const n = Number(process.env.COMMIT_BY_HOUR ?? 11);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : 11;
}

/**
 * Where the SQLite file lives.
 *  - Production (Embarko): ALWAYS under DATA_DIR, the only folder that survives redeploys. DATA_DIR is required;
 *    we refuse to fall back to a folder next to the code (it would be wiped on every deploy).
 *  - Development/tests: DATABASE_PATH, else DATA_DIR, else ./data.
 *  - e2e runs a production build against a throwaway file: VL_E2E_ALLOW=1 permits DATABASE_PATH there.
 */
export function databasePath(): string {
  const dataDir = process.env.DATA_DIR?.trim();
  if (process.env.NODE_ENV === "production" && process.env.VL_E2E_ALLOW !== "1") {
    if (!dataDir) throw new Error("DATA_DIR must be set in production (the database must live under it)");
    return path.join(dataDir, "value-ledger.db");
  }
  if (process.env.DATABASE_PATH) return process.env.DATABASE_PATH;
  if (dataDir) return path.join(dataDir, "value-ledger.db");
  return "./data/value-ledger.db";
}

export function sessionSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 32) return s;
  if (process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET must be set (>= 32 chars) in production");
  }
  // Development/test only: per-process random secret (sessions reset on restart).
  return (globalThis.__vlDevSecret ??= randomBytes(32).toString("hex"));
}

declare global {
  var __vlDevSecret: string | undefined;
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}
