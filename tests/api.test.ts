/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as logoutRoute } from "@/app/api/auth/logout/route";
import { GET as me } from "@/app/api/auth/me/route";
import { POST as addOutcomeRoute } from "@/app/api/days/[date]/outcomes/route";
import { POST as commitRoute } from "@/app/api/days/[date]/commit/route";
import { POST as closeDayRoute } from "@/app/api/days/[date]/close/route";
import { POST as unplannedRoute } from "@/app/api/days/[date]/unplanned/route";
import { POST as closeOutcomeRoute } from "@/app/api/outcomes/[id]/close/route";
import { GET as getGoalsRoute, PUT as putGoalsRoute } from "@/app/api/goals/[weekStart]/route";
import { GET as myDay } from "@/app/api/my-day/route";
import { GET as reportRoute } from "@/app/api/report/route";
import { PUT as reviewRoute } from "@/app/api/reviews/[outcomeId]/route";
import { PUT as noteRoute } from "@/app/api/day-notes/[date]/route";
import { GET as notificationsRoute } from "@/app/api/notifications/route";
import { POST as retryRoute } from "@/app/api/notifications/[id]/retry/route";
import { POST as testEventRoute } from "@/app/api/notifications/test/route";
import { getDb } from "@/db";
import { notifications } from "@/db/schema";
import { loginLimiter } from "@/lib/auth";
import { makeWorld, MON_0930 } from "./helpers";

const ORIGIN = "http://app.test";
type Handler = (req: Request, rc?: { params?: Promise<Record<string, string>> }) => Promise<Response>;

function req(method: string, path: string, opts: { body?: unknown; cookie?: string; origin?: string | null; raw?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
  if (opts.cookie) headers.cookie = opts.cookie;
  const body = method === "GET" ? undefined : (opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)));
  return new Request(`${ORIGIN}${path}`, { method, headers, body });
}
const call = async (h: Handler, r: Request, params: Record<string, string> = {}) => {
  const res = await h(r, { params: Promise.resolve(params) });
  return { status: res.status, body: (await res.json()) as any, headers: res.headers };
};

async function signIn(email: string) {
  const r = await call(login as Handler, req("POST", "/api/auth/login", { body: { email, password: "correct-horse-battery" } }));
  expect(r.status).toBe(200);
  const setCookie = r.headers.get("set-cookie")!;
  expect(setCookie).toMatch(/HttpOnly/i);
  expect(setCookie).toMatch(/SameSite=Lax/i);
  return setCookie.split(";")[0]!;
}

let owner: string;
let reviewer: string;
afterEach(() => {
  for (const k of ["VIASOCKET_HOOK_COMMIT", "VIASOCKET_SHARED_TOKEN"]) delete process.env[k];
});
beforeEach(async () => {
  const w = await makeWorld();
  globalThis.__vlDb = w.db;
  process.env.VL_TEST_NOW = MON_0930.toISOString();
  loginLimiter.reset("local|owner@example.test");
  owner = await signIn("owner@example.test");
  reviewer = await signIn("reviewer@example.test");
});

const D = { date: "2026-11-09" };
const owned: Array<[string, string, unknown, unknown, Record<string, string>]> = [
  ["POST", "/api/days/2026-11-09/outcomes", addOutcomeRoute, { title: "t", doneMeans: "d", level: 4 }, D],
  ["POST", "/api/days/2026-11-09/commit", commitRoute, {}, D],
  ["POST", "/api/days/2026-11-09/close", closeDayRoute, { highlight: "h" }, D],
  ["POST", "/api/days/2026-11-09/unplanned", unplannedRoute, { title: "t", level: 1, result: "r", proofUrl: "https://a.b" }, D],
  ["POST", "/api/outcomes/1/close", closeOutcomeRoute, { status: "missed", reason: "r" }, { id: "1" }],
  ["GET", "/api/my-day", myDay, undefined, {}],
];

describe("authentication & authorization over HTTP", () => {
  it("anonymous requests get 401 on every protected route", async () => {
    for (const [m, p, h, body, params] of owned) {
      const r = await call(h as Handler, req(m, p, { body }), params);
      expect(r.status, `${m} ${p}`).toBe(401);
      expect(r.body.error.code).toBe("unauthorized");
    }
    expect((await call(me as Handler, req("GET", "/api/auth/me"))).status).toBe(401);
  });

  it("a reviewer gets 403 on every owner write (and the owner-only My Day)", async () => {
    for (const [m, p, h, body, params] of owned) {
      const r = await call(h as Handler, req(m, p, { body, cookie: reviewer }), params);
      expect(r.status, `${m} ${p}`).toBe(403);
    }
  });

  it("me returns the signed-in user without any password hash", async () => {
    const r = await call(me as Handler, req("GET", "/api/auth/me", { cookie: owner }));
    expect(r.body.data.user).toEqual({ id: expect.any(Number), name: "Olive Owner", email: "owner@example.test", role: "owner" });
    expect(JSON.stringify(r.body)).not.toMatch(/hash|password/i);
  });

  it("logout invalidates the session server-side", async () => {
    const r = await call(logoutRoute as Handler, req("POST", "/api/auth/logout", { cookie: owner }));
    expect(r.status).toBe(200);
    expect((await call(me as Handler, req("GET", "/api/auth/me", { cookie: owner }))).status).toBe(401);
  });

  it("wrong password is 401; malformed login body is 422; bad JSON is 400", async () => {
    expect((await call(login as Handler, req("POST", "/api/auth/login", { body: { email: "owner@example.test", password: "nope" } }))).status).toBe(401);
    expect((await call(login as Handler, req("POST", "/api/auth/login", { body: { email: "" } }))).status).toBe(422);
    expect((await call(login as Handler, req("POST", "/api/auth/login", { raw: "{not json" }))).status).toBe(400);
  });
});

describe("CSRF / same-origin on mutations", () => {
  it("rejects a cross-origin or origin-less mutation even with a valid session (403)", async () => {
    const body = { title: "t", doneMeans: "d", level: 4 };
    for (const origin of ["http://evil.test", null]) {
      const r = await call(addOutcomeRoute as Handler, req("POST", "/api/days/2026-11-09/outcomes", { body, cookie: owner, origin }), D);
      expect(r.status).toBe(403);
    }
    const ok = await call(addOutcomeRoute as Handler, req("POST", "/api/days/2026-11-09/outcomes", { body, cookie: owner }), D);
    expect(ok.status).toBe(201);
  });
});

describe("owner flow over HTTP", () => {
  it("plan → commit → close with proof, with consistent error codes", async () => {
    const add = (n: number, level = 4) =>
      call(addOutcomeRoute as Handler, req("POST", `/api/days/${D.date}/outcomes`, { cookie: owner, body: { title: `T${n}`, doneMeans: "checkable", level } }), D);
    const first = await add(1);
    expect(first.status).toBe(201);
    await add(2);
    await add(3);
    expect((await add(4)).status).toBe(422); // fourth outcome
    expect((await add(5, 3)).status).toBe(422); // invalid level
    const commit = () => call(commitRoute as Handler, req("POST", "/api/days/2026-11-09/commit", { cookie: owner, body: {} }), D);
    expect((await commit()).status).toBe(200);
    expect((await commit()).status).toBe(409);
    const id = first.body.data.outcome.id as number;
    const close = (body: unknown) => call(closeOutcomeRoute as Handler, req("POST", `/api/outcomes/${id}/close`, { cookie: owner, body }), { id: String(id) });
    expect((await close({ status: "done", result: "x" })).status).toBe(422);
    const dayClose = await call(closeDayRoute as Handler, req("POST", "/api/days/2026-11-09/close", { cookie: owner, body: { highlight: "h" } }), D);
    expect(dayClose.status).toBe(409);
    expect((await close({ status: "done", proofUrl: "https://example.com/x", result: "changed" })).status).toBe(200);
    expect((await call(closeOutcomeRoute as Handler, req("POST", "/api/outcomes/abc/close", { cookie: owner, body: {} }), { id: "abc" })).status).toBe(400);
    const view = await call(myDay as Handler, req("GET", "/api/my-day?date=2026-11-09", { cookie: owner }));
    expect(view.status).toBe(200);
    expect(view.body.data.planned).toHaveLength(3);
    expect(view.body.data.summary.promisedPoints).toBe(12);
    expect(view.body.data.summary.promisesKept).toBe(33);
  });

  it("goals: owner and reviewer read and write; anonymous 401; non-Monday 400", async () => {
    const W = { weekStart: "2026-11-09" };
    const body = { goals: [{ text: "Launch the Zoho Books plug", measure: "Published with 10 actions" }] };
    expect((await call(putGoalsRoute as Handler, req("PUT", "/api/goals/2026-11-09", { cookie: reviewer, body }), W)).status).toBe(200);
    const g = await call(getGoalsRoute as Handler, req("GET", "/api/goals/2026-11-09", { cookie: owner }), W);
    expect(g.body.data.goals).toHaveLength(1);
    expect((await call(putGoalsRoute as Handler, req("PUT", "/api/goals/2026-11-09", { body }), W)).status).toBe(401);
    expect((await call(putGoalsRoute as Handler, req("PUT", "/api/goals/2026-11-10", { cookie: owner, body }), { weekStart: "2026-11-10" })).status).toBe(400);
  });
});

describe("reviewer verification over HTTP", () => {
  async function deliveredOutcome() {
    const add = await call(addOutcomeRoute as Handler, req("POST", "/api/days/2026-11-09/outcomes", { cookie: owner, body: { title: "Ship it", doneMeans: "Live", level: 4 } }), D);
    const id = add.body.data.outcome.id as number;
    await call(commitRoute as Handler, req("POST", "/api/days/2026-11-09/commit", { cookie: owner, body: {} }), D);
    await call(closeOutcomeRoute as Handler, req("POST", `/api/outcomes/${id}/close`, { cookie: owner, body: { status: "done", proofUrl: "https://example.com/p", result: "Live now" } }), { id: String(id) });
    await call(closeDayRoute as Handler, req("POST", "/api/days/2026-11-09/close", { cookie: owner, body: { highlight: "Shipped" } }), D);
    return id;
  }

  it("the owner cannot modify reviewer scores or notes (403); anonymous gets 401", async () => {
    const id = await deliveredOutcome();
    const P = { outcomeId: String(id) };
    expect((await call(reviewRoute as Handler, req("PUT", `/api/reviews/${id}`, { cookie: owner, body: { confirmedPoints: 8 } }), P)).status).toBe(403);
    expect((await call(noteRoute as Handler, req("PUT", "/api/day-notes/2026-11-09", { cookie: owner, body: { note: "x" } }), D)).status).toBe(403);
    expect((await call(reviewRoute as Handler, req("PUT", `/api/reviews/${id}`, { body: { confirmedPoints: 8 } }), P)).status).toBe(401);
    const rep = await call(reportRoute as Handler, req("GET", "/api/report?week=2026-11-09", { cookie: owner }));
    expect(rep.body.data.value).toEqual({ confirmed: 0, awaiting: 4, total: 4 });
  });

  it("a reviewer scores, the report reflects it, and bad input gets 400/422", async () => {
    const id = await deliveredOutcome();
    const P = { outcomeId: String(id) };
    const put = (body: unknown, cookie = reviewer, origin?: string) =>
      call(reviewRoute as Handler, req("PUT", `/api/reviews/${id}`, { cookie, body, origin }), P);
    expect((await put({ confirmedPoints: 3 })).status).toBe(422);
    expect((await put({ confirmedPoints: 8 }, reviewer, "http://evil.test")).status).toBe(403);
    expect((await put({ confirmedPoints: 8 })).status).toBe(200);
    expect((await call(reviewRoute as Handler, req("PUT", "/api/reviews/abc", { cookie: reviewer, body: { confirmedPoints: 8 } }), { outcomeId: "abc" })).status).toBe(400);
    expect((await call(noteRoute as Handler, req("PUT", "/api/day-notes/2026-11-09", { cookie: reviewer, body: { note: "Great work" } }), D)).status).toBe(200);
    const rep = await call(reportRoute as Handler, req("GET", "/api/report", { cookie: reviewer }));
    expect(rep.status).toBe(200);
    expect(rep.body.data.value).toEqual({ confirmed: 8, awaiting: 0, total: 8 });
    expect(rep.body.data.measures.claimAccuracy.percent).toBe(200);
    expect(rep.body.data.days[0].notes[0].note).toBe("Great work");
    expect((await call(reportRoute as Handler, req("GET", "/api/report?week=2026-11-10", { cookie: reviewer }))).status).toBe(400);
    expect((await call(reportRoute as Handler, req("GET", "/api/report"))).status).toBe(401);
  });
});

describe("notification endpoints (owner only)", () => {
  const SECRETS = { VIASOCKET_HOOK_COMMIT: "https://flow.sokt.io/func/scrSECRETID", VIASOCKET_SHARED_TOKEN: "tok_super_secret_value" };
  beforeEach(() => void Object.assign(process.env, SECRETS));

  it("anonymous 401, reviewer 403 on list, retry and test", async () => {
    for (const cookie of [undefined, reviewer]) {
      const status = cookie ? 403 : 401;
      expect((await call(notificationsRoute as Handler, req("GET", "/api/notifications", { cookie }))).status).toBe(status);
      expect((await call(retryRoute as Handler, req("POST", "/api/notifications/1/retry", { cookie, body: {} }), { id: "1" })).status).toBe(status);
      expect((await call(testEventRoute as Handler, req("POST", "/api/notifications/test", { cookie, body: { type: "commit" } }))).status).toBe(status);
    }
  });

  it("owner queues a test event, sees it in the log, and the response never contains URLs or tokens", async () => {
    expect((await call(testEventRoute as Handler, req("POST", "/api/notifications/test", { cookie: owner, body: { type: "nope" } }))).status).toBe(422);
    expect((await call(testEventRoute as Handler, req("POST", "/api/notifications/test", { cookie: owner, body: { type: "commit" }, origin: "http://evil.test" }))).status).toBe(403);
    const t = await call(testEventRoute as Handler, req("POST", "/api/notifications/test", { cookie: owner, body: { type: "commit" } }));
    expect(t.status).toBe(201);
    const list = await call(notificationsRoute as Handler, req("GET", "/api/notifications", { cookie: owner }));
    expect(list.status).toBe(200);
    expect(list.body.data.notifications[0]).toMatchObject({ type: "commit", status: "pending" });
    expect(list.body.data.health.hooks.find((h: any) => h.type === "commit").configured).toBe(true);
    expect(list.body.data.health.tokenConfigured).toBe(true);
    const text = JSON.stringify(list.body);
    for (const secret of [SECRETS.VIASOCKET_HOOK_COMMIT, "scrSECRETID", SECRETS.VIASOCKET_SHARED_TOKEN, "payload"]) expect(text).not.toContain(secret);
  });

  it("owner can retry only failed notifications", async () => {
    const t = await call(testEventRoute as Handler, req("POST", "/api/notifications/test", { cookie: owner, body: { type: "review" } }));
    const id = t.body.data.id as number;
    const retry = () => call(retryRoute as Handler, req("POST", `/api/notifications/${id}/retry`, { cookie: owner, body: {} }), { id: String(id) });
    expect((await retry()).status).toBe(409); // still pending
    const { eq } = await import("drizzle-orm");
    getDb().update(notifications).set({ status: "failed", lastError: "http_500" }).where(eq(notifications.id, id)).run();
    const ok = await retry();
    expect(ok.status).toBe(200);
    expect(ok.body.data).toEqual({ id, status: "pending" });
    expect((await call(retryRoute as Handler, req("POST", "/api/notifications/abc/retry", { cookie: owner, body: {} }), { id: "abc" })).status).toBe(400);
    expect((await call(retryRoute as Handler, req("POST", "/api/notifications/9999/retry", { cookie: owner, body: {} }), { id: "9999" })).status).toBe(404);
  });

  it("the business endpoints queue events as a side effect (commit → one 'commit' notification)", async () => {
    await call(addOutcomeRoute as Handler, req("POST", "/api/days/2026-11-09/outcomes", { cookie: owner, body: { title: "t", doneMeans: "d", level: 4 } }), D);
    await call(commitRoute as Handler, req("POST", "/api/days/2026-11-09/commit", { cookie: owner, body: {} }), D);
    await call(commitRoute as Handler, req("POST", "/api/days/2026-11-09/commit", { cookie: owner, body: {} }), D); // 409: no second event
    const list = await call(notificationsRoute as Handler, req("GET", "/api/notifications", { cookie: owner }));
    expect(list.body.data.notifications.map((n: any) => n.eventId)).toEqual(["commit:2026-11-09"]);
  });
});
