import { beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { auditLog } from "@/db/schema";
import { getSessionUser, login, loginLimiter, logout, requireRole, sessionCookie, clearedSessionCookie, SESSION_TTL_MS } from "@/lib/auth";
import { ApiError } from "@/lib/errors";
import { assertSameOrigin } from "@/lib/api";
import { dbErrorMessage, makeWorld, MON_0930, type World } from "./helpers";

let w: World;
beforeEach(async () => {
  w = await makeWorld();
  loginLimiter.reset("1.1.1.1|owner@example.test");
});

describe("authentication", () => {
  it("logs in, resolves the session, and logs out", async () => {
    const r = await login(w.db, { email: "OWNER@example.test", password: "correct-horse-battery", ip: "1.1.1.1" }, MON_0930);
    expect(r.user.role).toBe("owner");
    expect(getSessionUser(w.db, r.token, MON_0930)?.id).toBe(w.owner.id);
    logout(w.db, r.token, MON_0930);
    expect(getSessionUser(w.db, r.token, MON_0930)).toBeNull();
  });

  it("rejects bad credentials with 401 and never reveals which part was wrong", async () => {
    for (const email of ["owner@example.test", "nobody@example.test"]) {
      await expect(login(w.db, { email, password: "wrong-password", ip: "2.2.2.2" }, MON_0930)).rejects.toMatchObject({
        status: 401,
        code: "invalid_credentials",
      });
    }
  });

  it("expires sessions server-side", async () => {
    const r = await login(w.db, { email: "owner@example.test", password: "correct-horse-battery", ip: "1.1.1.1" }, MON_0930);
    const later = new Date(MON_0930.getTime() + SESSION_TTL_MS + 1);
    expect(getSessionUser(w.db, r.token, later)).toBeNull();
  });

  it("rate-limits repeated failures (429), even for the correct password afterwards", async () => {
    for (let i = 0; i < 5; i++) {
      await expect(login(w.db, { email: "owner@example.test", password: "nope-nope-nope", ip: "3.3.3.3" }, MON_0930)).rejects.toMatchObject({ status: 401 });
    }
    await expect(login(w.db, { email: "owner@example.test", password: "correct-horse-battery", ip: "3.3.3.3" }, MON_0930)).rejects.toMatchObject({ status: 429 });
    const later = new Date(MON_0930.getTime() + 16 * 60 * 1000);
    await expect(login(w.db, { email: "owner@example.test", password: "correct-horse-battery", ip: "3.3.3.3" }, later)).resolves.toBeTruthy();
  });

  it("stores only a hash of the session token, never the token", async () => {
    const r = await login(w.db, { email: "owner@example.test", password: "correct-horse-battery", ip: "1.1.1.1" }, MON_0930);
    const rows = w.db.all<{ id: string }>(sql`select id from sessions`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).not.toBe(r.token);
  });

  it("writes login/logout to the audit log", async () => {
    const r = await login(w.db, { email: "owner@example.test", password: "correct-horse-battery", ip: "1.1.1.1" }, MON_0930);
    logout(w.db, r.token, MON_0930);
    const actions = w.db.select().from(auditLog).all().map((a) => a.action);
    expect(actions).toEqual(["auth.login", "auth.logout"]);
  });
});

describe("role authorization", () => {
  it("401 when anonymous, 403 for the wrong role", () => {
    expect(() => requireRole(null, "owner")).toThrowError(expect.objectContaining({ status: 401 }));
    expect(() => requireRole(w.reviewer, "owner")).toThrowError(expect.objectContaining({ status: 403 }));
    expect(requireRole(w.owner, "owner").id).toBe(w.owner.id);
  });
});

describe("cookies", () => {
  it("is HttpOnly + SameSite and Secure in production", () => {
    const c = sessionCookie("tok", new Date());
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/SameSite=Lax/);
    expect(c).not.toMatch(/Secure/);
    const prev = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = "production";
    try {
      expect(sessionCookie("tok", new Date())).toMatch(/Secure/);
      expect(clearedSessionCookie()).toMatch(/Secure/);
    } finally {
      (process.env as Record<string, string>).NODE_ENV = prev!;
    }
  });
});

describe("same-origin (CSRF) check", () => {
  const mk = (method: string, headers: Record<string, string>) => new Request("http://app.test/api/x", { method, headers });
  it("allows GET without Origin", () => expect(() => assertSameOrigin(mk("GET", {}))).not.toThrow());
  it("allows matching Origin", () => expect(() => assertSameOrigin(mk("POST", { origin: "http://app.test" }))).not.toThrow());
  it("rejects missing Origin on mutations (403)", () => {
    expect(() => assertSameOrigin(mk("POST", {}))).toThrowError(expect.objectContaining({ status: 403 }));
  });
  it("rejects foreign Origin and cross-site fetch metadata (403)", () => {
    expect(() => assertSameOrigin(mk("PUT", { origin: "http://evil.test" }))).toThrowError(ApiError);
    expect(() => assertSameOrigin(mk("POST", { origin: "http://app.test", "sec-fetch-site": "cross-site" }))).toThrowError(expect.objectContaining({ status: 403 }));
  });
});

describe("audit log is append-only", () => {
  it("rejects UPDATE and DELETE", async () => {
    await login(w.db, { email: "owner@example.test", password: "correct-horse-battery", ip: "1.1.1.1" }, MON_0930);
    expect(dbErrorMessage(() => w.db.run(sql`update audit_log set action = 'x'`))).toMatch(/append-only/);
    expect(dbErrorMessage(() => w.db.run(sql`delete from audit_log`))).toMatch(/append-only/);
  });
});
