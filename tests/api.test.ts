/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it } from "vitest";
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
