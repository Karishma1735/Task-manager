/** Server-only configuration. Never import from client components. */
import { randomBytes } from "node:crypto";

export function appTz(): string {
  return process.env.APP_TZ || "Asia/Kolkata";
}

export function commitByHour(): number {
  const n = Number(process.env.COMMIT_BY_HOUR ?? 11);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : 11;
}

export function databasePath(): string {
  return process.env.DATABASE_PATH || "./data/value-ledger.db";
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
