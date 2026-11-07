/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { GET as healthRoute } from "@/app/api/health/route";
import { auditLog, users } from "@/db/schema";
import { openDatabase, runMigrations } from "@/db";
import { assertSameOrigin, errorResponse } from "@/lib/api";
import { emailLimiter, login, loginLimiter } from "@/lib/auth";
import { databasePath } from "@/lib/env";
import { assertProductionConfig, productionConfigProblems, seedFromEnvIfMissing } from "@/lib/startup";

const ENV_KEYS = ["NODE_ENV", "DATA_DIR", "DATABASE_PATH", "VL_E2E_ALLOW", "APP_BASE_URL"];
const saved: Record<string, string | undefined> = {};
let tmp: string;

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vl-data-"));
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else (process.env as Record<string, string>)[k] = saved[k]!;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});
const setEnv = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : ((process.env as Record<string, string>)[k] = v));

describe("database location", () => {
  it("production: always under DATA_DIR, ignoring any DATABASE_PATH", () => {
    setEnv("NODE_ENV", "production");
    setEnv("DATA_DIR", tmp);
    setEnv("DATABASE_PATH", "./data/elsewhere.db");
    expect(databasePath()).toBe(path.join(tmp, "value-ledger.db"));
  });
  it("production without DATA_DIR refuses to pick a folder next to the code", () => {
    setEnv("NODE_ENV", "production");
    setEnv("DATA_DIR", undefined);
    expect(() => databasePath()).toThrow(/DATA_DIR must be set/);
  });
  it("development keeps ./data, DATABASE_PATH or DATA_DIR", () => {
    setEnv("NODE_ENV", "development");
    setEnv("DATA_DIR", undefined);
    setEnv("DATABASE_PATH", undefined);
    expect(databasePath()).toBe("./data/value-ledger.db");
    setEnv("DATABASE_PATH", "/x/y.db");
    expect(databasePath()).toBe("/x/y.db");
    setEnv("DATABASE_PATH", undefined);
    setEnv("DATA_DIR", tmp);
    expect(databasePath()).toBe(path.join(tmp, "value-ledger.db"));
  });
  it("only the e2e run may use DATABASE_PATH in a production build", () => {
    setEnv("NODE_ENV", "production");
    setEnv("DATA_DIR", undefined);
    setEnv("VL_E2E_ALLOW", "1");
    setEnv("DATABASE_PATH", ".e2e/e2e.db");
    expect(databasePath()).toBe(".e2e/e2e.db");
  });
});

describe("production configuration guard", () => {
  const good = { NODE_ENV: "production", DATA_DIR: "/data", SESSION_SECRET: "x".repeat(32) } as unknown as NodeJS.ProcessEnv;
  it("accepts a correct configuration and is silent outside production", () => {
    expect(productionConfigProblems(good)).toEqual([]);
    expect(productionConfigProblems({ NODE_ENV: "development" } as NodeJS.ProcessEnv)).toEqual([]);
    expect(() => assertProductionConfig(good)).not.toThrow();
  });
  it("refuses to start without DATA_DIR or a strong SESSION_SECRET", () => {
    expect(productionConfigProblems({ ...good, DATA_DIR: "" })).toEqual([expect.stringMatching(/DATA_DIR/)]);
    expect(productionConfigProblems({ ...good, SESSION_SECRET: "short" })).toEqual([expect.stringMatching(/SESSION_SECRET/)]);
    expect(() => assertProductionConfig({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(/Refusing to start/);
  });
  it("refuses test-only clock and webhook overrides in production", () => {
    for (const k of ["VL_TEST_NOW", "VL_ALLOW_TEST_CLOCK", "VIASOCKET_ALLOW_ANY_HOST"]) {
      expect(productionConfigProblems({ ...good, [k]: "1" })).toEqual([expect.stringContaining(k)]);
    }
  });
  it("refuses enabled reminders without a REMINDER_TOKEN", () => {
    expect(productionConfigProblems({ ...good, SCHEDULED_REMINDERS_ENABLED: "1" })).toEqual([expect.stringMatching(/REMINDER_TOKEN/)]);
    expect(productionConfigProblems({ ...good, SCHEDULED_REMINDERS_ENABLED: "1", REMINDER_TOKEN: "t".repeat(20) })).toEqual([]);
  });
  it("the error message never contains secret values", () => {
    try {
      assertProductionConfig({ NODE_ENV: "production", SESSION_SECRET: "super-secret-short" } as NodeJS.ProcessEnv);
    } catch (e) {
      expect(String(e)).not.toContain("super-secret-short");
    }
  });
});

describe("persistence under DATA_DIR (restart/redeploy safety)", () => {
  const dbFile = () => path.join(tmp, "value-ledger.db");
  const seedEnv = {
    OWNER_NAME: "Olive",
    OWNER_EMAIL: "owner@example.test",
    OWNER_PASSWORD: "first-owner-password-123",
    REVIEWER_NAME: "Ravi",
    REVIEWER_EMAIL: "reviewer@example.test",
    REVIEWER_PASSWORD: "first-reviewer-password-123",
  } as unknown as NodeJS.ProcessEnv;

  it("data survives closing and reopening the database file; migrations are a no-op the second time", async () => {
    let db = openDatabase(dbFile());
    runMigrations(db);
    await seedFromEnvIfMissing(db, seedEnv);
    const before = db.select().from(users).all();
    expect(before.map((u) => u.role).sort()).toEqual(["owner", "reviewer"]);
    const audits = db.select().from(auditLog).all().length;
    (db as any).$client.close();

    db = openDatabase(dbFile()); // "restart"
    runMigrations(db);
    runMigrations(db);
    expect(db.select().from(users).all()).toEqual(before);
    expect(db.select().from(auditLog).all()).toHaveLength(audits);
    expect(fs.existsSync(dbFile())).toBe(true);
    (db as any).$client.close();
  });

  it("works with Embarko's bookkeeping tables present, and leaves them alone", () => {
    const db = openDatabase(dbFile());
    db.run(sql`create table _litestream_seq (id integer primary key, seq integer)`);
    db.run(sql`create table _litestream_lock (id integer primary key)`);
    db.run(sql`insert into _litestream_seq values (1, 7)`);
    runMigrations(db);
    runMigrations(db);
    expect(db.all<{ seq: number }>(sql`select seq from _litestream_seq`)).toEqual([{ seq: 7 }]);
    const tables = db.all<{ name: string }>(sql`select name from sqlite_master where type='table'`).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(["_litestream_seq", "_litestream_lock", "users", "outcomes", "notifications", "audit_log"]));
    (db as any).$client.close();
  });

  it("creates the database only under the data directory — nothing next to the code", () => {
    const cwdFiles = fs.readdirSync(process.cwd());
    const db = openDatabase(dbFile());
    runMigrations(db);
    (db as any).$client.close();
    expect(fs.readdirSync(process.cwd())).toEqual(cwdFiles);
    expect(fs.readdirSync(tmp).some((f) => f.startsWith("value-ledger.db"))).toBe(true);
  });

  it("creates parent folders on first start", () => {
    const nested = path.join(tmp, "a", "b", "app.db");
    const db = openDatabase(nested);
    runMigrations(db);
    (db as any).$client.close();
    expect(fs.existsSync(nested)).toBe(true);
  });
});

describe("startup seeding never overwrites production data", () => {
  const env = (o: Record<string, string> = {}) =>
    ({
      OWNER_NAME: "Olive",
      OWNER_EMAIL: "owner@example.test",
      OWNER_PASSWORD: "first-owner-password-123",
      REVIEWER_NAME: "Ravi",
      REVIEWER_EMAIL: "reviewer@example.test",
      REVIEWER_PASSWORD: "first-reviewer-password-123",
      ...o,
    }) as unknown as NodeJS.ProcessEnv;
  const fresh = () => {
    const db = openDatabase(":memory:");
    runMigrations(db);
    return db;
  };

  it("first start creates the owner and the reviewer", async () => {
    const db = fresh();
    expect(await seedFromEnvIfMissing(db, env())).toEqual({ ownerCreated: true, reviewerCreated: true, skipped: null });
    expect(db.select().from(users).all()).toHaveLength(2);
  });

  it("every later start changes nothing, even if the password variables changed", async () => {
    const db = fresh();
    await seedFromEnvIfMissing(db, env());
    const before = db.select().from(users).all();
    const again = await seedFromEnvIfMissing(db, env({ OWNER_PASSWORD: "a-completely-different-password", REVIEWER_PASSWORD: "another-different-password-1" }));
    expect(again).toEqual({ ownerCreated: false, reviewerCreated: false, skipped: null });
    expect(db.select().from(users).all()).toEqual(before); // hashes identical: nothing was reset
  });

  it("a second owner is never created, e.g. if OWNER_EMAIL is edited later", async () => {
    const db = fresh();
    await seedFromEnvIfMissing(db, env());
    const r = await seedFromEnvIfMissing(db, env({ OWNER_EMAIL: "someone.else@example.test" }));
    expect(r.ownerCreated).toBe(false);
    expect(db.select().from(users).where(eq(users.role, "owner")).all()).toHaveLength(1);
  });

  it("an additional reviewer can be added by a new REVIEWER_EMAIL (the spec allows several)", async () => {
    const db = fresh();
    await seedFromEnvIfMissing(db, env());
    const r = await seedFromEnvIfMissing(db, env({ REVIEWER_EMAIL: "second.reviewer@example.test" }));
    expect(r.reviewerCreated).toBe(true);
    expect(db.select().from(users).where(eq(users.role, "reviewer")).all()).toHaveLength(2);
  });

  it("missing variables skip seeding quietly; a weak password stops startup with a clear error", async () => {
    const db = fresh();
    expect((await seedFromEnvIfMissing(db, {} as NodeJS.ProcessEnv)).skipped).toMatch(/not all set/);
    expect(db.select().from(users).all()).toHaveLength(0);
    await expect(seedFromEnvIfMissing(db, env({ OWNER_PASSWORD: "short" }))).rejects.toThrow(/at least 12 characters/);
  });

  it("the seeded accounts can sign in, and the log records the seeding without the passwords", async () => {
    const db = fresh();
    process.env.BCRYPT_COST = "4";
    await seedFromEnvIfMissing(db, env());
    loginLimiter.reset("1.1.1.1|owner@example.test");
    emailLimiter.reset("owner@example.test");
    const r = await login(db, { email: "owner@example.test", password: "first-owner-password-123", ip: "1.1.1.1" }, new Date());
    expect(r.user.role).toBe("owner");
    const dump = JSON.stringify(db.select().from(auditLog).all());
    expect(dump).not.toContain("first-owner-password-123");
    expect(dump).not.toContain("first-reviewer-password-123");
  });
});

describe("health endpoint", () => {
  it("reports ok and reveals nothing else", async () => {
    globalThis.__vlDb = openDatabase(":memory:");
    runMigrations(globalThis.__vlDb);
    const res = healthRoute();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
  it("answers 503 (without internals) when the database is unavailable", async () => {
    globalThis.__vlDb = new Proxy({}, { get: () => { throw new Error("disk /secret/path failed"); } }) as never;
    const res = healthRoute();
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toMatch(/secret|path|failed/);
  });
});

describe("same-origin behind a hosting proxy", () => {
  const mk = (headers: Record<string, string>) => new Request("http://127.0.0.1:8080/api/x", { method: "POST", headers });
  it("accepts the app's public origin from APP_BASE_URL even when Host is an internal name", () => {
    setEnv("APP_BASE_URL", "https://value-ledger.embarko.app");
    expect(() => assertSameOrigin(mk({ origin: "https://value-ledger.embarko.app", host: "127.0.0.1:8080" }))).not.toThrow();
  });
  it("still rejects any other origin", () => {
    setEnv("APP_BASE_URL", "https://value-ledger.embarko.app");
    expect(() => assertSameOrigin(mk({ origin: "https://evil.example", host: "127.0.0.1:8080" }))).toThrowError(expect.objectContaining({ status: 403 }));
    setEnv("APP_BASE_URL", undefined);
    expect(() => assertSameOrigin(mk({ origin: "https://value-ledger.embarko.app" }))).toThrowError(expect.objectContaining({ status: 403 }));
  });
});

describe("login throttling cannot be dodged by spoofing the client address", () => {
  it("rotating x-forwarded-for does not reset the per-email limit", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db);
    process.env.BCRYPT_COST = "4";
    const now = new Date("2026-11-09T04:00:00Z");
    emailLimiter.reset("victim@example.test");
    let last: any;
    for (let i = 0; i < 21; i++) {
      last = await login(db, { email: "victim@example.test", password: "wrong-password-xx", ip: `10.0.0.${i}` }, now).catch((e) => e);
    }
    expect(last).toMatchObject({ status: 429, code: "rate_limited" });
    emailLimiter.reset("victim@example.test");
  });
});

describe("logging hygiene", () => {
  it("unexpected errors are logged by type only — never the message (which can hold SQL parameters)", async () => {
    const logged: unknown[][] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void logged.push(a);
    try {
      const err = Object.assign(new Error("Failed query: insert into outcomes params: Secret proof https://private.example/p"), { code: "SQLITE_CONSTRAINT" });
      const res = errorResponse(err);
      expect(res.status).toBe(500);
      expect(JSON.stringify(await res.json())).not.toMatch(/Secret|private|Failed query/);
    } finally {
      console.error = orig;
    }
    const text = JSON.stringify(logged);
    expect(text).toContain("SQLITE_CONSTRAINT");
    expect(text).not.toMatch(/Secret|private\.example|Failed query|params/);
  });
});
