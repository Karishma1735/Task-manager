/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { auditLog, deliveryLog, notifications } from "@/db/schema";
import { addOutcome, closeDay, closeOutcome, commitDay, logUnplanned, type Cfg } from "@/lib/ledger";
import { deliver, enqueue, listNotifications, processDue, queueTestEvent, retryNotification, safeError, type Fetch } from "@/lib/outbox";
import { putDayNote, putReview } from "@/lib/reviews";
import { EVENT_TYPES, hookUrl, webhookHealth } from "@/lib/viasocket";
import { makeWorld, type World } from "./helpers";

const cfg: Cfg = { tz: "Asia/Kolkata", commitByHour: 11 };
const DATE = "2026-11-09";
const AM = new Date("2026-11-09T04:00:00Z"); // 09:30 IST
const PM = new Date("2026-11-09T12:30:00Z");
const HOOKS = {
  VIASOCKET_HOOK_COMMIT: "https://flow.sokt.io/func/scrCOMMIT",
  VIASOCKET_HOOK_REPORT: "https://flow.sokt.io/func/scrREPORT",
  VIASOCKET_HOOK_REVIEW: "https://flow.sokt.io/func/scrREVIEW",
  VIASOCKET_SHARED_TOKEN: "tok_test_shared_secret_value",
};
const PROOF = "https://private.example.com/proof/abc123";

let w: World;
let now: Date;
const clock = () => now;

beforeEach(async () => {
  w = await makeWorld();
  now = new Date(AM);
  Object.assign(process.env, HOOKS, { OUTBOX_RETRY_DELAYS_MIN: "1,5,30", APP_BASE_URL: "https://ledger.test" });
});
afterEach(() => {
  for (const k of [...Object.keys(HOOKS), "OUTBOX_RETRY_DELAYS_MIN", "APP_BASE_URL", "VIASOCKET_HOST_ALLOWLIST"]) delete process.env[k];
});

interface Call {
  url: string;
  body: any;
}
function mockFetch(handler: (c: Call, n: number) => Response | Promise<Response> = () => new Response("{}", { status: 200 })) {
  const calls: Call[] = [];
  const fn: Fetch = async (url, init) => {
    const call = { url, body: JSON.parse(String(init.body)) };
    calls.push(call);
    return handler(call, calls.length);
  };
  return { fn, calls };
}

const rows = () => w.db.select().from(notifications).orderBy(notifications.id).all();
const plan = (levels: number[] = [8, 2]) =>
  levels.map((level, i) => addOutcome(w.db, w.owner, DATE, { title: `Outcome ${i + 1}`, doneMeans: `Done means ${i + 1}`, level }, AM, cfg).id);

function fullDay() {
  const ids = plan([8, 2, 1]);
  commitDay(w.db, w.owner, DATE, AM, cfg);
  closeOutcome(w.db, w.owner, ids[0]!, { status: "done", proofUrl: PROOF, result: "Shipped the thing" }, PM, cfg);
  closeOutcome(w.db, w.owner, ids[1]!, { status: "done", proofUrl: "https://private.example.com/proof/two", result: "Second" }, PM, cfg);
  closeOutcome(w.db, w.owner, ids[2]!, { status: "missed", reason: "No time" }, PM, cfg);
  logUnplanned(w.db, w.owner, DATE, { title: "Urgent fix", level: 4, result: "Fixed", proofUrl: "https://private.example.com/incident" }, PM, cfg);
  closeDay(w.db, w.owner, DATE, { highlight: "Shipped the thing", learning: "Start earlier" }, PM, cfg);
  now = new Date(PM.getTime() + 1000); // time only moves forward: everything queued above is now due
  return ids;
}

describe("event creation (transactional outbox)", () => {
  it("commit queues one 'commit' event with planned outcomes, levels and no token", () => {
    plan([8, 2]);
    expect(rows()).toHaveLength(0); // drafts send nothing
    commitDay(w.db, w.owner, DATE, AM, cfg);
    const [n] = rows();
    expect(n).toMatchObject({ eventId: `commit:${DATE}`, type: "commit", status: "pending", attempts: 0 });
    const p = JSON.parse(n!.payloadJson);
    expect(p).toMatchObject({ event_id: `commit:${DATE}`, type: "commit", date: DATE, owner_name: "Olive Owner", committed_points: 10, commit_by: "11:00 Asia/Kolkata" });
    expect(p.outcomes).toEqual([
      expect.objectContaining({ title: "Outcome 1", done_means: "Done means 1", level: 8, level_name: "Multiplier", planned: true, status: "open" }),
      expect.objectContaining({ title: "Outcome 2", level: 2, level_name: "Progress" }),
    ]);
    expect(p.report_url).toBe("https://ledger.test/report?week=2026-11-09");
    expect(n!.payloadJson).not.toContain(HOOKS.VIASOCKET_SHARED_TOKEN); // token only added at send time
    expect(p).not.toHaveProperty("token");
  });

  it("closing the day queues 'daily_report' with value, promises kept, evidence, highlight and learning", () => {
    fullDay();
    const n = rows().find((r) => r.type === "daily_report")!;
    expect(n.eventId).toBe(`daily_report:${DATE}`);
    const p = JSON.parse(n.payloadJson);
    expect(p).toMatchObject({
      type: "daily_report",
      date: DATE,
      owner_name: "Olive Owner",
      committed_points: 11,
      delivered_points: 14, // 8 + 2 planned + 4 unplanned (claimed, awaiting review)
      promised_delivered_points: 10,
      unplanned_points: 4,
      promises_kept_pct: 91, // 10 ÷ 11
      verification: "awaiting_review",
      highlight: "Shipped the thing",
      learning: "Start earlier",
    });
    expect(p.outcomes).toHaveLength(4);
    expect(p.outcomes[0]).toMatchObject({ title: "Outcome 1", level: 8, planned: true, status: "done", result: "Shipped the thing", proof_url: PROOF });
    expect(p.outcomes[2]).toMatchObject({ status: "missed", result: "No time", proof_url: "" });
    expect(p.outcomes[3]).toMatchObject({ title: "Urgent fix", planned: false, proof_url: "https://private.example.com/incident" });
  });

  it("promises_kept_pct is null (not NaN/100) when nothing was committed", () => {
    closeDay(w.db, w.owner, DATE, { highlight: "Rest day" }, PM, cfg);
    const p = JSON.parse(rows()[0]!.payloadJson);
    expect(p.promises_kept_pct).toBeNull();
    expect(p.committed_points).toBe(0);
  });

  it("a reviewer score queues 'review' with claimed and confirmed points and notes", () => {
    const ids = fullDay();
    putDayNote(w.db, w.reviewer, DATE, { note: "Strong day" }, PM);
    putReview(w.db, w.reviewer, ids[0]!, { confirmedPoints: 4 }, PM);
    const reviewEvents = rows().filter((r) => r.type === "review");
    expect(reviewEvents).toHaveLength(2);
    const p = JSON.parse(reviewEvents[1]!.payloadJson);
    expect(p).toMatchObject({
      type: "review",
      date: DATE,
      reviewer_name: "Ravi Reviewer",
      change: "score",
      changed_outcome: { title: "Outcome 1", claimed_points: 8, confirmed_points: 4 },
      confirmed_points_total: 4,
      awaiting_review_points_total: 6, // 2 + 4 unplanned still awaiting
    });
    expect(p.outcomes[0]).toMatchObject({ title: "Outcome 1", claimed_points: 8, confirmed_points: 4, status: "confirmed" });
    expect(p.outcomes[1]).toMatchObject({ confirmed_points: null, status: "awaiting_review" });
    expect(p.reviewer_notes).toEqual([{ reviewer: "Ravi Reviewer", note: "Strong day" }]);
    expect(JSON.stringify(p)).not.toContain("proof"); // review messages carry no evidence links
    expect(JSON.parse(reviewEvents[0]!.payloadJson).change).toBe("note");
  });

  it("review events have distinct ids so legitimate later changes are never discarded", () => {
    const ids = fullDay();
    putReview(w.db, w.reviewer, ids[0]!, { confirmedPoints: 4 }, PM);
    putReview(w.db, w.reviewer, ids[0]!, { confirmedPoints: 4 }, PM); // unchanged → no event
    putReview(w.db, w.reviewer, ids[0]!, { confirmedPoints: 8 }, new Date(PM.getTime() + 1000));
    putReview(w.db, w.reviewer, ids[1]!, { confirmedPoints: 0 }, new Date(PM.getTime() + 2000));
    const ids2 = rows().filter((r) => r.type === "review").map((r) => r.eventId);
    expect(ids2).toHaveLength(3);
    expect(new Set(ids2).size).toBe(3);
    ids2.forEach((id) => expect(id).toMatch(new RegExp(`^review:${DATE}:\\d+$`)));
  });

  it("enqueue deduplicates by event id", () => {
    const ev = { eventId: "commit:2026-11-09", type: "commit" as const, date: DATE, payload: { a: 1 } };
    const a = w.db.transaction((tx) => enqueue(tx, ev, now));
    const b = w.db.transaction((tx) => enqueue(tx, { ...ev, payload: { a: 2 } }, now));
    expect(a.duplicate).toBe(false);
    expect(b).toEqual({ id: a.id, duplicate: true });
    expect(rows()).toHaveLength(1);
    expect(JSON.parse(rows()[0]!.payloadJson)).toEqual({ a: 1 });
  });
});

describe("no notification for failed business transactions", () => {
  it("rejected commits, closes and reviews queue nothing", () => {
    const ids = plan([4]);
    expect(() => commitDay(w.db, w.owner, DATE, new Date("2026-11-09T05:30:00Z"), cfg)).toThrow(); // after the deadline
    expect(() => commitDay(w.db, w.reviewer, DATE, AM, cfg)).toThrow(); // wrong role
    commitDay(w.db, w.owner, DATE, AM, cfg);
    expect(() => closeDay(w.db, w.owner, DATE, { highlight: "x" }, PM, cfg)).toThrow(); // outcome still open
    closeOutcome(w.db, w.owner, ids[0]!, { status: "done", proofUrl: PROOF, result: "ok" }, PM, cfg);
    closeDay(w.db, w.owner, DATE, { highlight: "x" }, PM, cfg);
    expect(() => putReview(w.db, w.reviewer, ids[0]!, { confirmedPoints: 3 }, PM)).toThrow(); // invalid points
    expect(() => putReview(w.db, w.owner, ids[0]!, { confirmedPoints: 4 }, PM)).toThrow(); // owner cannot review
    expect(rows().map((r) => r.eventId)).toEqual([`commit:${DATE}`, `daily_report:${DATE}`]);
  });

  it("if the outbox write fails, the business change rolls back too (same transaction)", () => {
    plan([4]);
    w.db.run(sql`create trigger no_outbox before insert on notifications begin select raise(abort, 'outbox down'); end`);
    expect(() => commitDay(w.db, w.owner, DATE, AM, cfg)).toThrow();
    expect(w.db.all<{ locked_at: string | null }>(sql`select locked_at from days where date = ${DATE}`)[0]!.locked_at).toBeNull();
    expect(w.db.select().from(auditLog).all().some((a) => a.action === "day.commit")).toBe(false);
  });
});

describe("delivery", () => {
  it("POSTs the payload with the shared token to the configured flow and marks it sent", async () => {
    plan([4]);
    commitDay(w.db, w.owner, DATE, AM, cfg);
    const { fn, calls } = mockFetch();
    expect(await processDue(w.db, clock, fn)).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(HOOKS.VIASOCKET_HOOK_COMMIT);
    expect(calls[0]!.body).toMatchObject({ token: HOOKS.VIASOCKET_SHARED_TOKEN, event_id: `commit:${DATE}`, type: "commit", committed_points: 4 });
    expect(rows()[0]).toMatchObject({ status: "sent", attempts: 1, lastError: null, sentAt: AM.toISOString(), nextAttemptAt: null });
    expect(w.db.select().from(deliveryLog).all()).toEqual([expect.objectContaining({ attempt: 1, outcome: "sent", httpStatus: 200, error: null })]);
  });

  it("routes each event type to its own flow", async () => {
    const ids = fullDay();
    putReview(w.db, w.reviewer, ids[0]!, { confirmedPoints: 4 }, PM);
    const { fn, calls } = mockFetch();
    await processDue(w.db, clock, fn);
    const byType = Object.fromEntries(calls.map((c) => [c.body.type, c.url]));
    expect(byType).toEqual({ commit: HOOKS.VIASOCKET_HOOK_COMMIT, daily_report: HOOKS.VIASOCKET_HOOK_REPORT, review: HOOKS.VIASOCKET_HOOK_REVIEW });
  });

  it("never re-sends a delivered event, even when sweepers overlap (no duplicate Sheet rows)", async () => {
    fullDay();
    const { fn, calls } = mockFetch(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return new Response("{}", { status: 200 });
    });
    await Promise.all([processDue(w.db, clock, fn), processDue(w.db, clock, fn), processDue(w.db, clock, fn)]);
    await processDue(w.db, clock, fn);
    const ids = calls.map((c) => c.body.event_id);
    expect(ids.sort()).toEqual([`commit:${DATE}`, `daily_report:${DATE}`]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(rows().every((r) => r.status === "sent" && r.attempts === 1)).toBe(true);
  });

  it("every event id is delivered successfully at most once per business event", async () => {
    const ids = fullDay();
    putReview(w.db, w.reviewer, ids[0]!, { confirmedPoints: 4 }, PM);
    putReview(w.db, w.reviewer, ids[0]!, { confirmedPoints: 8 }, new Date(PM.getTime() + 1000));
    const { fn, calls } = mockFetch();
    await processDue(w.db, clock, fn);
    await processDue(w.db, clock, fn);
    const reports = calls.filter((c) => c.body.type === "daily_report");
    expect(reports).toHaveLength(1); // one sheet row per closed day
    expect(calls.filter((c) => c.body.type === "review")).toHaveLength(2); // both edits delivered
  });

  it("a delivery failure never rolls back or alters the business data", async () => {
    plan([4]);
    commitDay(w.db, w.owner, DATE, AM, cfg);
    const { fn } = mockFetch(() => new Response("boom", { status: 500 }));
    await processDue(w.db, clock, fn);
    expect(w.db.all<{ locked_at: string }>(sql`select locked_at from days where date = ${DATE}`)[0]!.locked_at).toBe(AM.toISOString());
    expect(rows()[0]!.status).toBe("pending");
  });
});

describe("failure handling and retries", () => {
  it("retries after 1, 5 and 30 minutes, then marks the row failed", async () => {
    plan([4]);
    commitDay(w.db, w.owner, DATE, AM, cfg);
    const { fn, calls } = mockFetch(() => new Response("nope", { status: 503 }));
    const minutes = (m: number) => new Date(AM.getTime() + m * 60_000);

    await processDue(w.db, clock, fn); // attempt 1 at t=0
    expect(rows()[0]).toMatchObject({ status: "pending", attempts: 1, lastError: "http_503", nextAttemptAt: minutes(1).toISOString() });

    now = minutes(0.5);
    await processDue(w.db, clock, fn); // not due yet
    expect(calls).toHaveLength(1);

    now = minutes(1);
    await processDue(w.db, clock, fn); // attempt 2 → next in 5 min
    expect(rows()[0]).toMatchObject({ status: "pending", attempts: 2, nextAttemptAt: minutes(6).toISOString() });

    now = minutes(6);
    await processDue(w.db, clock, fn); // attempt 3 → next in 30 min
    expect(rows()[0]).toMatchObject({ status: "pending", attempts: 3, nextAttemptAt: minutes(36).toISOString() });

    now = minutes(36);
    await processDue(w.db, clock, fn); // attempt 4 → failed
    expect(rows()[0]).toMatchObject({ status: "failed", attempts: 4, lastError: "http_503", nextAttemptAt: null });
    expect(calls).toHaveLength(4);

    now = minutes(600);
    await processDue(w.db, clock, fn); // failed rows are never retried automatically
    expect(calls).toHaveLength(4);
    expect(w.db.select().from(deliveryLog).all().map((l) => l.outcome)).toEqual(["retry_scheduled", "retry_scheduled", "retry_scheduled", "failed"]);
  });

  it("succeeds on a later attempt and stops retrying", async () => {
    plan([4]);
    commitDay(w.db, w.owner, DATE, AM, cfg);
    const { fn, calls } = mockFetch((_c, n) => new Response("{}", { status: n < 3 ? 500 : 200 }));
    for (const m of [0, 1, 6, 60]) {
      now = new Date(AM.getTime() + m * 60_000);
      await processDue(w.db, clock, fn);
    }
    expect(calls).toHaveLength(3);
    expect(rows()[0]).toMatchObject({ status: "sent", attempts: 3, lastError: null });
  });

  it("network errors and timeouts become short codes; messages (which may hold URLs) are discarded", async () => {
    expect(safeError(new TypeError(`fetch failed ${HOOKS.VIASOCKET_HOOK_COMMIT}`))).toBe("network_error");
    expect(safeError(Object.assign(new Error("x"), { name: "AbortError" }))).toBe("timeout");
    expect(safeError(Object.assign(new Error("x"), { name: "TimeoutError" }))).toBe("timeout");
    expect(safeError(null, 502)).toBe("http_502");
    plan([4]);
    commitDay(w.db, w.owner, DATE, AM, cfg);
    const fn: Fetch = async (url) => {
      throw new TypeError(`connect ECONNREFUSED ${url} token=${HOOKS.VIASOCKET_SHARED_TOKEN}`);
    };
    await processDue(w.db, clock, fn);
    expect(rows()[0]!.lastError).toBe("network_error");
  });

  it("not configured: fails immediately without calling out, and says so", async () => {
    delete process.env.VIASOCKET_HOOK_COMMIT;
    plan([4]);
    commitDay(w.db, w.owner, DATE, AM, cfg);
    const { fn, calls } = mockFetch();
    await processDue(w.db, clock, fn);
    expect(calls).toHaveLength(0);
    expect(rows()[0]).toMatchObject({ status: "failed", lastError: "not_configured", attempts: 1 });
    delete process.env.VIASOCKET_SHARED_TOKEN;
    process.env.VIASOCKET_HOOK_COMMIT = HOOKS.VIASOCKET_HOOK_COMMIT;
    expect(webhookHealth().tokenConfigured).toBe(false);
  });

  it("delivery logs, last_error and the Settings listing contain no proof links, URLs, tokens or work text", async () => {
    fullDay();
    const { fn } = mockFetch(() => new Response(`oops ${PROOF}`, { status: 500 }));
    await processDue(w.db, clock, fn);
    const dump = JSON.stringify({
      log: w.db.select().from(deliveryLog).all(),
      list: listNotifications(w.db),
      errors: rows().map((r) => r.lastError),
    });
    for (const secret of [PROOF, "private.example.com", "flow.sokt.io", "scrCOMMIT", "scrREPORT", HOOKS.VIASOCKET_SHARED_TOKEN, "Shipped the thing", "Outcome 1"]) {
      expect(dump, secret).not.toContain(secret);
    }
  });

  it("does not follow redirects or leak the response body into the log", async () => {
    plan([4]);
    commitDay(w.db, w.owner, DATE, AM, cfg);
    let init: RequestInit | undefined;
    const fn: Fetch = async (_u, i) => {
      init = i;
      return new Response("{}", { status: 200 });
    };
    await processDue(w.db, clock, fn);
    expect(init!.redirect).toBe("error");
    expect(init!.method).toBe("POST");
  });
});

describe("manual retry (owner only)", () => {
  async function failedRow() {
    plan([4]);
    commitDay(w.db, w.owner, DATE, AM, cfg);
    process.env.OUTBOX_RETRY_DELAYS_MIN = "0,0,0";
    await processDue(w.db, clock, mockFetch(() => new Response("x", { status: 500 })).fn);
    expect(rows()[0]!.status).toBe("failed");
    return rows()[0]!.id;
  }

  it("resets a failed notification, delivers it, and audits the actor", async () => {
    const id = await failedRow();
    const n = retryNotification(w.db, w.owner, id, now);
    expect(n).toMatchObject({ status: "pending", attempts: 0, lastError: null });
    const { fn, calls } = mockFetch();
    await processDue(w.db, clock, fn);
    expect(calls).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ status: "sent", attempts: 1 });
    const a = w.db.select().from(auditLog).all().find((x) => x.action === "notification.retry")!;
    expect(a).toMatchObject({ actorId: w.owner.id, entity: "notification", entityId: String(id) });
    expect(JSON.parse(a.beforeJson!).status).toBe("failed");
  });

  it("only failed notifications can be retried (409); unknown is 404", async () => {
    const id = await failedRow();
    retryNotification(w.db, w.owner, id, now);
    expect(() => retryNotification(w.db, w.owner, id, now)).toThrowError(expect.objectContaining({ status: 409 }));
    expect(() => retryNotification(w.db, w.owner, 999, now)).toThrowError(expect.objectContaining({ status: 404 }));
  });
});

describe("test events", () => {
  it("are labelled is_test, use unique ids, and carry no real data", async () => {
    const a = queueTestEvent(w.db, w.owner, "daily_report", now);
    const b = queueTestEvent(w.db, w.owner, "daily_report", new Date(now.getTime() + 1));
    expect(a).not.toBe(b);
    const p = JSON.parse(rows()[0]!.payloadJson);
    expect(p).toMatchObject({ is_test: true, type: "daily_report", owner_name: "Test Owner" });
    expect(p.outcomes[0].title).toMatch(/TEST EVENT/);
    expect(rows()[0]!.eventId).toMatch(/^test:daily_report:\d+$/);
    expect(w.db.select().from(auditLog).all().filter((x) => x.action === "notification.test")).toHaveLength(2);
    const { fn, calls } = mockFetch();
    await processDue(w.db, clock, fn);
    expect(calls.every((c) => c.body.is_test === true)).toBe(true);
  });
});

describe("configuration safety", () => {
  it("accepts only https URLs on flow.sokt.io (plus an explicit allow-list)", () => {
    expect(hookUrl("commit")).toBe(HOOKS.VIASOCKET_HOOK_COMMIT);
    process.env.VIASOCKET_HOOK_COMMIT = "http://flow.sokt.io/func/x";
    expect(hookUrl("commit")).toBeNull();
    process.env.VIASOCKET_HOOK_COMMIT = "https://evil.example.com/func/x";
    expect(hookUrl("commit")).toBeNull();
    process.env.VIASOCKET_HOST_ALLOWLIST = "hooks.corp.test";
    process.env.VIASOCKET_HOOK_COMMIT = "https://hooks.corp.test/func/x";
    expect(hookUrl("commit")).toBe("https://hooks.corp.test/func/x");
    process.env.VIASOCKET_HOOK_COMMIT = "not a url";
    expect(hookUrl("commit")).toBeNull();
  });

  it("health reports configured/not configured and never the values", () => {
    const h = webhookHealth();
    expect(h.hooks.map((x) => [x.type, x.flow, x.configured])).toEqual([
      ["commit", "ledger_commit", true],
      ["daily_report", "ledger_daily_report", true],
      ["review", "ledger_review", true],
    ]);
    expect(JSON.stringify(h)).not.toMatch(/flow\.sokt\.io|tok_test/);
    expect(EVENT_TYPES).toHaveLength(3);
  });

  it("an unknown event type is never delivered (left alone, no call out)", async () => {
    const id = w.db.transaction((tx) => enqueue(tx, { eventId: "weird:1", type: "weird" as never, date: DATE, payload: {} }, now).id);
    const { fn, calls } = mockFetch();
    expect(await deliver(w.db, id, clock, fn)).toBeNull();
    expect(await processDue(w.db, clock, fn)).toBe(0);
    expect(calls).toHaveLength(0);
    expect(rows()[0]!.status).toBe("pending");
  });
});

describe("timeout handling", () => {
  it("an aborted request is recorded as a timeout and retried", async () => {
    plan([4]);
    commitDay(w.db, w.owner, DATE, AM, cfg);
    const spy = vi.spyOn(AbortSignal, "timeout");
    const fn: Fetch = async () => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    };
    await processDue(w.db, clock, fn);
    expect(spy).toHaveBeenCalledWith(10_000);
    expect(rows()[0]).toMatchObject({ status: "pending", lastError: "timeout", attempts: 1 });
    spy.mockRestore();
  });
});
