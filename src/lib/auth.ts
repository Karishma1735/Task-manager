import { createHmac, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { sessions, users, type User } from "@/db/schema";
import { writeAudit } from "@/lib/audit";
import { ApiError, forbidden, unauthorized } from "@/lib/errors";
import { AttemptLimiter } from "@/lib/rate-limit";
import { isProduction, sessionSecret } from "@/lib/env";

export type Role = "owner" | "reviewer";
export interface Actor {
  id: number;
  name: string;
  email: string;
  role: Role;
}

export const SESSION_COOKIE = "vl_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const BCRYPT_COST = Number(process.env.BCRYPT_COST ?? 12);

export const toActor = (u: Pick<User, "id" | "name" | "email" | "role">): Actor => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
});

export function hashPassword(plain: string, cost = BCRYPT_COST): Promise<string> {
  return bcrypt.hash(plain, cost);
}

// Compared against when the email is unknown so response time doesn't reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 4);

const sessionKey = (token: string) => createHmac("sha256", sessionSecret()).update(token).digest("hex");

export const loginLimiter = new AttemptLimiter(5, 15 * 60 * 1000);
const ipLimiter = new AttemptLimiter(30, 15 * 60 * 1000);

export interface LoginResult {
  token: string;
  expiresAt: Date;
  user: Actor;
}

export async function login(
  db: Db,
  input: { email: string; password: string; ip: string },
  now: Date,
): Promise<LoginResult> {
  const email = input.email.trim().toLowerCase();
  const nowMs = now.getTime();
  const userKey = `${input.ip}|${email}`;
  const wait = Math.max(loginLimiter.retryAfterMs(userKey, nowMs), ipLimiter.retryAfterMs(input.ip, nowMs));
  if (wait > 0) {
    throw new ApiError(429, "rate_limited", "Too many sign-in attempts. Try again later.", {
      retryAfterSeconds: Math.ceil(wait / 1000),
    });
  }
  const user = db.select().from(users).where(eq(users.email, email)).get();
  const ok = await bcrypt.compare(input.password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok) {
    loginLimiter.fail(userKey, nowMs);
    ipLimiter.fail(input.ip, nowMs);
    throw new ApiError(401, "invalid_credentials", "Invalid email or password");
  }
  loginLimiter.reset(userKey);
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(nowMs + SESSION_TTL_MS);
  db.transaction((tx) => {
    tx.insert(sessions)
      .values({ id: sessionKey(token), userId: user.id, createdAt: now.toISOString(), expiresAt: expiresAt.toISOString() })
      .run();
    writeAudit(tx, { at: now, actorId: user.id, action: "auth.login", entity: "session", entityId: user.id, after: { role: user.role } });
  });
  return { token, expiresAt, user: toActor(user) };
}

export function getSessionUser(db: Db, token: string | undefined | null, now: Date): Actor | null {
  if (!token) return null;
  const id = sessionKey(token);
  const row = db
    .select({ s: sessions, u: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, id))
    .get();
  if (!row) return null;
  if (new Date(row.s.expiresAt).getTime() <= now.getTime()) {
    db.delete(sessions).where(eq(sessions.id, id)).run();
    return null;
  }
  return toActor(row.u);
}

export function logout(db: Db, token: string | undefined | null, now: Date): void {
  if (!token) return;
  const id = sessionKey(token);
  const row = db.select().from(sessions).where(eq(sessions.id, id)).get();
  if (!row) return;
  db.transaction((tx) => {
    tx.delete(sessions).where(eq(sessions.id, id)).run();
    writeAudit(tx, { at: now, actorId: row.userId, action: "auth.logout", entity: "session", entityId: row.userId });
  });
}

export function requireRole(actor: Actor | null, ...roles: Role[]): Actor {
  if (!actor) throw unauthorized();
  if (!roles.includes(actor.role)) throw forbidden();
  return actor;
}

export function readCookie(header: string | null | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

export function sessionCookie(token: string, expiresAt: Date): string {
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${expiresAt.toUTCString()}`,
  ];
  if (isProduction()) attrs.push("Secure");
  return attrs.join("; ");
}

export function clearedSessionCookie(): string {
  const attrs = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (isProduction()) attrs.push("Secure");
  return attrs.join("; ");
}
