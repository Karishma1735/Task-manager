/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as statusRoute } from "@/app/api/status/route";
import { POST as claimRoute } from "@/app/api/scheduled/claim/route";
import { POST as confirmRoute } from "@/app/api/scheduled/confirm/route";
import { GET as reportRoute } from "@/app/api/report/route";
import { POST as loginRoute } from "@/app/api/auth/login/route";
import { deliveryLog, notifications } from "@/db/schema";
import { buildDigest } from "@/lib/digest";
import { addOutcome, closeDay, closeOutcome, commitDay, logUnplanned, type Cfg } from "@/lib/ledger";
import { processDue } from "@/lib/outbox";
import { getReport } from "@/lib/report";
import { putReview } from "@/lib/reviews";
import { claimScheduled, confirmScheduled, getStatus, isWorkday, scheduledEventId, weekdayOf } from "@/lib/scheduled";
import { tokenLimiter } from "@/lib/scheduled-auth";
import { loginLimiter } from "@/lib/auth";
import { localDate } from "@/lib/time";
import { makeWorld, type World } from "./helpers";

const cfg: Cfg = { tz: "Asia/Kolkata", commitByHour: 11 };
const TOKEN = "reminder-token-for-tests-0123456789";
// All instants below are written in UTC; IST = UTC+5:30.
const MON_1030 = new Date("2026-11-09T05:00:00Z");
const MON_1059_59 = new Date("2026-11-09T05:29:59.999Z");
const MON_1100 = new Date("2026-11-09T05:30:00Z");
const MON_1830 = new Date("2026-11-09T13:00:00Z");
const FRI_1730 = new Date("2026-11-13T12:00:00Z");
const SAT_1030 = new Date("2026-11-14T05:00:00Z");
const MIN = 60_000;

let w: World;
beforeEach(async () => {
  w = await makeWorld();
  process.env.REMINDER_TOKEN = TOKEN;
  process.env.SCHEDULED_REMINDERS_ENABLED = "1";
});
afterEach(() => {
  for (const k of ["REMINDER_TOKEN", "SCHEDULED_REMINDERS_ENABLED", "VIASOCKET_HOOK_COMMIT", "VIASOCKET_SHARED_TOKEN"]) delete process.env[k];
  tokenLimiter.reset("local");
});

const rows = () => w.db.select().from(notifications).all();
const claim = (kind: string, now: Date) => claimScheduled(w.db, { kind }, now, cfg);

function plan(date: string, levels = [4]) {
  const at = new Date(`${date}T04:00:00Z`);
  return levels.map((level, i) => addOutcome(w.db, w.owner, date, { title: `Outcome ${i + 1}`, doneMeans: "Checkable", level }, at, cfg).id);
}
function commit(date: string, levels = [4]) {
  const ids = plan(date, levels);
  commitDay(w.db, w.owner, date, new Date(`${date}T04:00:00Z`), cfg);
  return ids;
}

describe("time and weekday helpers", () => {
  it("weekdays and working days", () => {
    expect(weekdayOf("2026-11-09")).toBe("Mon");
    expect(weekdayOf("2026-11-13")).toBe("Fri");
    expect(weekdayOf("2026-11-14")).toBe("Sat");
    expect(isWorkday("2026-11-15")).toBe(false);
    expect(isWorkday("2026-11-16")).toBe(true);
  });
  it("converts UTC instants to the India date (the scheduler's clock never decides the date)", () => {
    expect(localDate(new Date("2026-11-12T18:29:59Z"), "Asia/Kolkata")).toBe("2026-11-12"); // Thu 23:59 IST
    expect(localDate(new Date("2026-11-12T18:30:00Z"), "Asia/Kolkata")).toBe("2026-11-13"); // Fri 00:00 IST
    expect(getStatus(w.db, "today", new Date("2026-11-12T19:00:00Z"), cfg)).toMatchObject({ date: "2026-11-13", weekday: "Fri" });
    expect(getStatus(w.db, "today", new Date("2026-11-12T18:00:00Z"), cfg)).toMatchObject({ date: "2026-11-12", weekday: "Thu" });
  });
});

describe("GET status", () => {
  it("missing morning commitment: reminder is due and nothing is committed", () => {
    const s = getStatus(w.db, "today", MON_1030, cfg);
    expect(s).toMatchObject({ date: "2026-11-09", isWorkday: true, committed: false, hasDraft: false, closed: false });
    expect(s.due).toEqual({ morning: true, evening: false });
    expect(s.commitDeadlineAt).toBe("2026-11-09T05:30:00.000Z");
  });
  it("a draft plan is not a commitment", () => {
    plan("2026-11-09");
    const s = getStatus(w.db, "today", MON_1030, cfg);
    expect(s).toMatchObject({ committed: false, hasDraft: true });
    expect(s.due.morning).toBe(true);
  });
  it("an already committed plan: no morning reminder is due", () => {
    commit("2026-11-09");
    const s = getStatus(w.db, "today", MON_1030, cfg);
    expect(s).toMatchObject({ committed: true, closed: false });
    expect(s.due.morning).toBe(false);
  });
  it("open day at the evening reminder: due; closed day: not due", () => {
    const [id] = commit("2026-11-09");
    expect(getStatus(w.db, "today", MON_1830, cfg).due).toEqual({ morning: false, evening: true });
    closeOutcome(w.db, w.owner, id!, { status: "done", proofUrl: "https://a.b/c", result: "r" }, MON_1830, cfg);
    closeDay(w.db, w.owner, "2026-11-09", { highlight: "h" }, MON_1830, cfg);
    const s = getStatus(w.db, "today", MON_1830, cfg);
    expect(s.closed).toBe(true);
    expect(s.due.evening).toBe(false);
  });
  it("the evening reminder is not due before 17:00 local; the morning one not after the deadline", () => {
    expect(getStatus(w.db, "today", MON_1030, cfg).due.evening).toBe(false);
    expect(getStatus(w.db, "today", MON_1100, cfg).due.morning).toBe(false);
    expect(getStatus(w.db, "today", MON_1059_59, cfg).due.morning).toBe(true);
  });
  it("weekend: nothing is due", () => {
    const s = getStatus(w.db, "today", SAT_1030, cfg);
    expect(s).toMatchObject({ date: "2026-11-14", weekday: "Sat", isWorkday: false });
    expect(s.due).toEqual({ morning: false, evening: false });
  });
  it("validates the date parameter", () => {
    expect(getStatus(w.db, null, MON_1030, cfg).date).toBe("2026-11-09");
    expect(getStatus(w.db, "2026-11-08", MON_1030, cfg).date).toBe("2026-11-08");
    expect(() => getStatus(w.db, "nope", MON_1030, cfg)).toThrowError(expect.objectContaining({ status: 400 }));
    expect(() => getStatus(w.db, "2026-02-30", MON_1030, cfg)).toThrowError(expect.objectContaining({ status: 400 }));
    expect(() => getStatus(w.db, "2027-01-01", MON_1030, cfg)).toThrowError(expect.objectContaining({ status: 422 }));
  });
  it("reveals no work content", () => {
    commit("2026-11-09", [8]);
    const text = JSON.stringify(getStatus(w.db, "today", MON_1030, cfg));
    expect(text).not.toMatch(/Outcome|Checkable|proof|https?:/);
  });
});

describe("claim: idempotent reminders", () => {
  it("is disabled by default — nothing can be sent until approved", () => {
    delete process.env.SCHEDULED_REMINDERS_ENABLED;
    expect(claim("reminder_morning", MON_1030)).toEqual({ send: false, reason: "disabled" });
    process.env.SCHEDULED_REMINDERS_ENABLED = "0";
    expect(claim("reminder_morning", MON_1030)).toEqual({ send: false, reason: "disabled" });
    expect(rows()).toHaveLength(0);
  });

  it("missing commitment: the first claim says send, with a morning-specific event id", () => {
    expect(claim("reminder_morning", MON_1030)).toEqual({ send: true, eventId: "reminder_morning:2026-11-09", attempt: 1 });
    expect(rows()[0]).toMatchObject({ type: "reminder_morning", status: "pending" });
  });

  it("already committed: nothing to do, no record created", () => {
    commit("2026-11-09");
    expect(claim("reminder_morning", MON_1030)).toEqual({ send: false, reason: "already_committed" });
    expect(rows().filter((r) => r.type.startsWith("reminder"))).toHaveLength(0); // (the commit itself queued its own Phase 3 event)
  });

  it("open day at the evening reminder: send; already closed: nothing", () => {
    const [id] = commit("2026-11-09");
    expect(claim("reminder_evening", MON_1830)).toEqual({ send: true, eventId: "reminder_evening:2026-11-09", attempt: 1 });
    w.db.delete(notifications).run();
    closeOutcome(w.db, w.owner, id!, { status: "missed", reason: "r" }, MON_1830, cfg);
    closeDay(w.db, w.owner, "2026-11-09", { highlight: "h" }, MON_1830, cfg);
    expect(claim("reminder_evening", MON_1830)).toEqual({ send: false, reason: "already_closed" });
  });

  it("morning and evening idempotency keys differ for the same date", () => {
    expect(scheduledEventId("reminder_morning", "2026-11-09")).not.toBe(scheduledEventId("reminder_evening", "2026-11-09"));
  });

  it("both reminder kinds can be claimed on the same day without colliding", async () => {
    // day never committed: morning due at 10:30, evening due at 18:30 (nothing closed)
    const a = claim("reminder_morning", MON_1030);
    const b = claim("reminder_evening", MON_1830);
    expect(a).toMatchObject({ send: true, eventId: "reminder_morning:2026-11-09" });
    expect(b).toMatchObject({ send: true, eventId: "reminder_evening:2026-11-09" });
    expect(rows().map((r) => r.eventId).sort()).toEqual(["reminder_evening:2026-11-09", "reminder_morning:2026-11-09"]);
  });

  it("duplicate scheduler execution: the second run does not send while the first is in progress", () => {
    expect(claim("reminder_morning", MON_1030).send).toBe(true);
    expect(claim("reminder_morning", new Date(MON_1030.getTime() + 5_000))).toEqual({ send: false, reason: "in_progress", eventId: "reminder_morning:2026-11-09" });
    expect(rows()).toHaveLength(1);
  });

  it("after the flow confirms a send, every later run is a no-op (never a duplicate reminder)", () => {
    claim("reminder_morning", MON_1030);
    expect(confirmScheduled(w.db, { eventId: "reminder_morning:2026-11-09", ok: true }, MON_1030)).toEqual({ status: "sent" });
    expect(claim("reminder_morning", new Date(MON_1030.getTime() + 20 * MIN))).toEqual({ send: false, reason: "already_sent", eventId: "reminder_morning:2026-11-09" });
    expect(confirmScheduled(w.db, { eventId: "reminder_morning:2026-11-09", ok: true }, MON_1030)).toEqual({ status: "sent" }); // idempotent
    expect(rows()[0]).toMatchObject({ status: "sent", sentAt: MON_1030.toISOString() });
  });

  it("the morning claim is refused at 11:00:00 sharp but allowed at 10:59:59.999", () => {
    expect(claim("reminder_morning", MON_1100)).toEqual({ send: false, reason: "deadline_passed" });
    expect(claim("reminder_morning", MON_1059_59).send).toBe(true);
  });

  it("the evening claim is refused before 17:00 local (e.g. a scheduler running in the wrong timezone)", () => {
    expect(claim("reminder_evening", MON_1030)).toEqual({ send: false, reason: "too_early" });
    expect(claim("reminder_evening", new Date("2026-11-09T11:29:59Z"))).toEqual({ send: false, reason: "too_early" }); // 16:59:59 IST
    expect(claim("reminder_evening", new Date("2026-11-09T11:30:00Z")).send).toBe(true); // 17:00 IST
  });

  it("a scheduler that fires at 10:30 UTC (= 16:00 IST) is harmless: too late for the morning reminder", () => {
    expect(claim("reminder_morning", new Date("2026-11-09T10:30:00Z"))).toEqual({ send: false, reason: "deadline_passed" });
  });

  it("weekend behaviour: no reminders on Saturday or Sunday, no digest", () => {
    expect(claim("reminder_morning", SAT_1030)).toEqual({ send: false, reason: "weekend" });
    expect(claim("reminder_evening", new Date("2026-11-15T13:00:00Z"))).toEqual({ send: false, reason: "weekend" });
    expect(claim("weekly_digest", new Date("2026-11-14T12:00:00Z"))).toEqual({ send: false, reason: "not_friday" });
    expect(rows()).toHaveLength(0);
  });

  it("retry handling: a failed send can be claimed again, up to three attempts", () => {
    const id = "reminder_morning:2026-11-09";
    expect(claim("reminder_morning", MON_1030)).toMatchObject({ send: true, attempt: 1 });
    expect(confirmScheduled(w.db, { eventId: id, ok: false, error: "slack_error" }, MON_1030)).toEqual({ status: "failed" });
    expect(rows()[0]).toMatchObject({ status: "failed", lastError: "slack_error" });
    expect(claim("reminder_morning", new Date(MON_1030.getTime() + 1000))).toMatchObject({ send: true, attempt: 2 });
    confirmScheduled(w.db, { eventId: id, ok: false, error: "gmail_error" }, MON_1030);
    expect(claim("reminder_morning", new Date(MON_1030.getTime() + 2000))).toMatchObject({ send: true, attempt: 3 });
    confirmScheduled(w.db, { eventId: id, ok: false }, MON_1030);
    expect(claim("reminder_morning", new Date(MON_1030.getTime() + 3000))).toEqual({ send: false, reason: "max_attempts", eventId: id });
    expect(rows()[0]!.lastError).toBe("flow_failed");
    expect(w.db.select().from(deliveryLog).all().map((l) => l.outcome)).toEqual(["failed", "failed", "failed"]);
  });

  it("a claim whose flow never reported back becomes claimable again after the 15-minute lease", () => {
    claim("reminder_morning", MON_1030);
    expect(claim("reminder_morning", new Date(MON_1030.getTime() + 14 * MIN)).send).toBe(false);
    expect(claim("reminder_morning", new Date(MON_1030.getTime() + 16 * MIN))).toMatchObject({ send: true, attempt: 2 });
  });

  it("validates input", () => {
    for (const bad of [{}, { kind: "nope" }, { kind: "reminder_morning", extra: 1 }, null, "x"]) {
      expect(() => claimScheduled(w.db, bad, MON_1030, cfg)).toThrowError(expect.objectContaining({ status: 422 }));
    }
    for (const bad of [
      { eventId: "x", ok: true },
      { eventId: "reminder_morning:2026-11-09", ok: "yes" },
      { eventId: "reminder_morning:2026-11-09", ok: false, error: "Has Spaces and https://leak.example" },
      { eventId: "reminder_morning:2026-11-09", ok: true, extra: 1 },
    ]) {
      expect(() => confirmScheduled(w.db, bad, MON_1030)).toThrowError(expect.objectContaining({ status: 422 }));
    }
    expect(() => confirmScheduled(w.db, { eventId: "reminder_morning:2026-11-09", ok: true }, MON_1030)).toThrowError(expect.objectContaining({ status: 404 }));
  });

  it("scheduled rows are never delivered by the Phase 3 outbox (no webhook call, no 'not_configured' failure)", async () => {
    process.env.VIASOCKET_HOOK_COMMIT = "https://flow.sokt.io/func/x";
    process.env.VIASOCKET_SHARED_TOKEN = "tok";
    claim("reminder_morning", MON_1030);
    let calls = 0;
    await processDue(w.db, () => new Date(MON_1030.getTime() + 60 * MIN), async () => {
      calls++;
      return new Response("{}");
    });
    expect(calls).toBe(0);
    expect(rows()[0]!.status).toBe("pending");
  });

  it("stores no payload content: claims and the delivery log carry only ids, statuses and short codes", () => {
    claim("reminder_morning", MON_1030);
    confirmScheduled(w.db, { eventId: "reminder_morning:2026-11-09", ok: false, error: "gmail_error" }, MON_1030);
    const dump = JSON.stringify([rows(), w.db.select().from(deliveryLog).all()]);
    expect(dump).not.toMatch(/token|https?:|proof/i);
  });
});

describe("weekly digest: one per week", () => {
  it("Friday 17:30 IST: first claim sends; reruns never duplicate; the week key is the Monday", () => {
    expect(claim("weekly_digest", new Date("2026-11-13T05:00:00Z"))).toEqual({ send: false, reason: "too_early" }); // Fri 10:30 IST
    expect(claim("weekly_digest", FRI_1730)).toEqual({ send: true, eventId: "weekly_digest:2026-11-09", attempt: 1 });
    expect(claim("weekly_digest", new Date(FRI_1730.getTime() + MIN))).toMatchObject({ send: false, reason: "in_progress" });
    confirmScheduled(w.db, { eventId: "weekly_digest:2026-11-09", ok: true }, FRI_1730);
    expect(claim("weekly_digest", new Date(FRI_1730.getTime() + 30 * MIN))).toMatchObject({ send: false, reason: "already_sent" });
    // next week gets its own digest
    expect(claim("weekly_digest", new Date("2026-11-20T12:00:00Z"))).toMatchObject({ send: true, eventId: "weekly_digest:2026-11-16" });
    expect(rows().map((r) => r.eventId)).toEqual(["weekly_digest:2026-11-09", "weekly_digest:2026-11-16"]);
  });

  it("a digest runs on Friday only", () => {
    for (const d of ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12"]) {
      expect(claim("weekly_digest", new Date(`${d}T12:00:00Z`))).toEqual({ send: false, reason: "not_friday" });
    }
  });
});

// ---------- digest content ----------

function fridayWeek(opts: { closeFriday: boolean }) {
  const ids: Record<string, number[]> = {};
  for (const [date, levels] of [["2026-11-09", [8, 2]], ["2026-11-13", [4, 1]]] as const) {
    const at = new Date(`${date}T04:00:00Z`);
    const eve = new Date(`${date}T11:00:00Z`);
    ids[date] = levels.map((level, i) => addOutcome(w.db, w.owner, date, { title: `${date.slice(5)} outcome ${i + 1}`, doneMeans: "Checkable", level }, at, cfg).id);
    commitDay(w.db, w.owner, date, at, cfg);
    closeOutcome(w.db, w.owner, ids[date]![0]!, { status: "done", proofUrl: `https://evidence.test/${date}/a`, result: "Done well" }, eve, cfg);
    closeOutcome(w.db, w.owner, ids[date]![1]!, { status: "missed", reason: "Blocked on vendor access" }, eve, cfg);
    if (date === "2026-11-09") {
      logUnplanned(w.db, w.owner, date, { title: "Urgent fix", level: 4, result: "Fixed", proofUrl: "https://evidence.test/urgent" }, eve, cfg);
      closeDay(w.db, w.owner, date, { highlight: "Launch" }, eve, cfg);
    } else if (opts.closeFriday) {
      closeDay(w.db, w.owner, date, { highlight: "Wrap-up" }, eve, cfg);
    }
  }
  putReview(w.db, w.reviewer, ids["2026-11-09"]![0]!, { confirmedPoints: 4 }, new Date("2026-11-09T14:00:00Z"));
  return ids;
}
const ctx = { now: FRI_1730, tz: "Asia/Kolkata", today: "2026-11-13" };

describe("digest content", () => {
  it("Friday snapshot while the day is open is clearly labelled as of 5:30 PM", () => {
    fridayWeek({ closeFriday: false });
    const r = getReport(w.db, "2026-11-09", FRI_1730, cfg);
    const d = buildDigest(r, ctx);
    expect(d.snapshot.isSnapshot).toBe(true);
    expect(d.snapshot.label).toMatch(/^SNAPSHOT as of 5:30 PM Asia\/Kolkata — today is still open/);
    expect(d.text).toContain("SNAPSHOT as of 5:30 PM Asia/Kolkata");
    expect(d.subject).toMatch(/\(snapshot\)$/);
  });

  it("once Friday is closed the digest is final, not a snapshot", () => {
    fridayWeek({ closeFriday: true });
    const d = buildDigest(getReport(w.db, "2026-11-09", FRI_1730, cfg), ctx);
    expect(d.snapshot.isSnapshot).toBe(false);
    expect(d.snapshot.label).toMatch(/^Final for the week/);
    expect(d.subject).not.toMatch(/snapshot/);
  });

  it("mid-week the digest is a snapshot even if today's day is closed (the week is not finished)", () => {
    fridayWeek({ closeFriday: true });
    const wed = new Date("2026-11-11T12:00:00Z");
    const d = buildDigest(getReport(w.db, "2026-11-09", wed, cfg), { now: wed, tz: "Asia/Kolkata", today: "2026-11-11" });
    expect(d.snapshot.isSnapshot).toBe(true);
    expect(d.snapshot.label).toMatch(/the week is still in progress/);
    const sat = new Date("2026-11-14T12:00:00Z");
    expect(buildDigest(getReport(w.db, "2026-11-09", sat, cfg), { now: sat, tz: "Asia/Kolkata", today: "2026-11-14" }).snapshot.isSnapshot).toBe(false);
  });

  it("a past week is never a snapshot", () => {
    fridayWeek({ closeFriday: false });
    const d = buildDigest(getReport(w.db, "2026-11-09", new Date("2026-11-23T12:00:00Z"), cfg), { ...ctx, now: new Date("2026-11-23T12:00:00Z"), today: "2026-11-23" });
    expect(d.snapshot.isSnapshot).toBe(false);
  });

  it("contains value split, all six measures (matching the report exactly), top outcomes, evidence and unresolved items", () => {
    fridayWeek({ closeFriday: false });
    const r = getReport(w.db, "2026-11-09", FRI_1730, cfg);
    const d = buildDigest(r, ctx);
    // value: Mon 8→4 confirmed; Mon unplanned 4 awaiting; Fri 4 awaiting  => 4 confirmed + 8 awaiting
    expect(r.value).toEqual({ confirmed: 4, awaiting: 8, total: 12 });
    expect(d.text).toContain("VALUE DELIVERED: 12 points — 4 confirmed plus 8 awaiting review");
    const m = r.measures;
    expect(d.text).toContain(`Promises kept (weighted by points): ${m.promisesKept.percent}%`);
    expect(d.text).toContain(`High-leverage share: ${m.highLeverageShare.percent}%`);
    expect(d.text).toContain(`On goal: ${m.onGoal.percent === null ? "not available yet" : `${m.onGoal.percent}%`}`);
    expect(d.text).toContain(`Claim accuracy: ${m.claimAccuracy.percent}%`);
    expect(d.text).toContain(`Unplanned share: ${m.unplannedShare.percent}%`);
    expect(d.text).toContain(`Rhythm: ${m.rhythm.percent}%`);
    expect(m.claimAccuracy.percent).toBe(50); // 4 ÷ 8, reviewed only
    // top outcomes by effective points (4 confirmed, then claimed 4s)
    expect(d.topOutcomes.map((t) => t.points)).toEqual([4, 4, 4]);
    expect(d.text).toContain("Evidence: https://evidence.test/2026-11-09/a");
    expect(d.text).toContain("https://evidence.test/urgent");
    expect(d.text).toContain("https://evidence.test/2026-11-13/a");
    // unresolved: both missed outcomes with their reasons
    expect(d.unresolved).toHaveLength(2);
    expect(d.text).toContain("(missed): Blocked on vendor access");
    // reviewed vs awaiting wording
    expect(d.text).toContain("Confirmed by reviewer: 4 points (claimed 8)");
    expect(d.text).toContain("Awaiting review (claimed 4)");
  });

  it("an empty week reads cleanly with unavailable measures (no NaN, no invented numbers)", () => {
    const r = getReport(w.db, "2026-11-09", FRI_1730, cfg);
    const d = buildDigest(r, ctx);
    expect(d.text).toContain("VALUE DELIVERED: 0 points — 0 confirmed plus 0 awaiting review");
    expect(d.text).toContain("Promises kept (weighted by points): not available yet");
    expect(d.text).toContain("• Nothing delivered with value yet.");
    expect(d.text).not.toMatch(/NaN|undefined|null|Infinity/);
    expect(d.unresolved).toEqual([]);
  });

  it("uses no task counts and no metrics beyond the spec's six", () => {
    fridayWeek({ closeFriday: true });
    const text = buildDigest(getReport(w.db, "2026-11-09", FRI_1730, cfg), ctx).text;
    expect(text).not.toMatch(/\b(tasks?|streak|hours?)\b/i);
  });
});

// ---------- HTTP ----------

const ORIGIN = "http://app.test";
const jsonReq = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) =>
  new Request(`${ORIGIN}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const run = async (h: (r: Request, rc?: any) => Promise<Response>, r: Request) => {
  const res = await h(r, { params: Promise.resolve({}) });
  return { status: res.status, body: (await res.json()) as any };
};
const auth = { "x-reminder-token": TOKEN };

describe("protected endpoints over HTTP", () => {
  beforeEach(() => {
    globalThis.__vlDb = w.db;
    process.env.VL_TEST_NOW = MON_1030.toISOString();
  });
  afterEach(() => void delete process.env.VL_TEST_NOW);

  it("status: invalid or missing token → 401; correct token → 200", async () => {
    expect((await run(statusRoute as any, jsonReq("GET", "/api/status?date=today"))).status).toBe(401);
    expect((await run(statusRoute as any, jsonReq("GET", "/api/status?date=today", { "x-reminder-token": "wrong-token-wrong-token" }))).status).toBe(401);
    const ok = await run(statusRoute as any, jsonReq("GET", "/api/status?date=today", auth));
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ date: "2026-11-09", committed: false, due: { morning: true, evening: false } });
    expect(JSON.stringify(ok.body)).not.toContain(TOKEN);
  });

  it("a signed-in session does not open the scheduled endpoints, and the token does not act as a session", async () => {
    loginLimiter.reset("local|owner@example.test");
    const login = await run(loginRoute as any, jsonReq("POST", "/api/auth/login", { origin: ORIGIN }, { email: "owner@example.test", password: "correct-horse-battery" }));
    expect(login.status).toBe(200);
    expect((await run(statusRoute as any, jsonReq("GET", "/api/status"))).status).toBe(401);
  });

  it("a token in the URL is refused (400) and is never accepted from a query parameter", async () => {
    expect((await run(statusRoute as any, jsonReq("GET", `/api/status?token=${TOKEN}`))).status).toBe(400);
    expect((await run(statusRoute as any, jsonReq("GET", `/api/status?token=${TOKEN}`, auth))).status).toBe(400);
    expect((await run(reportRoute as any, jsonReq("GET", `/api/report?reminder_token=${TOKEN}`, auth))).status).toBe(400);
  });

  it("not configured → 503 (the endpoints are closed, not open)", async () => {
    delete process.env.REMINDER_TOKEN;
    const r = await run(statusRoute as any, jsonReq("GET", "/api/status", auth));
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("scheduled_disabled");
    process.env.REMINDER_TOKEN = "short";
    expect((await run(statusRoute as any, jsonReq("GET", "/api/status", { "x-reminder-token": "short" }))).status).toBe(503);
  });

  it("repeated bad tokens are rate-limited (429), even for the right token afterwards", async () => {
    for (let i = 0; i < 10; i++) {
      expect((await run(statusRoute as any, jsonReq("GET", "/api/status", { "x-reminder-token": `bad-token-number-${i}-xxxxxxxx` }))).status).toBe(401);
    }
    expect((await run(statusRoute as any, jsonReq("GET", "/api/status", auth))).status).toBe(429);
  });

  it("status validates the date (400/422)", async () => {
    expect((await run(statusRoute as any, jsonReq("GET", "/api/status?date=garbage", auth))).status).toBe(400);
    expect((await run(statusRoute as any, jsonReq("GET", "/api/status?date=2030-01-01", auth))).status).toBe(422);
  });

  it("claim and confirm work with the token and no Origin header, and are idempotent", async () => {
    const c1 = await run(claimRoute as any, jsonReq("POST", "/api/scheduled/claim", auth, { kind: "reminder_morning" }));
    expect(c1.body.data).toEqual({ send: true, eventId: "reminder_morning:2026-11-09", attempt: 1 });
    const c2 = await run(claimRoute as any, jsonReq("POST", "/api/scheduled/claim", auth, { kind: "reminder_morning" }));
    expect(c2.body.data.send).toBe(false);
    expect((await run(confirmRoute as any, jsonReq("POST", "/api/scheduled/confirm", auth, { eventId: c1.body.data.eventId, ok: true }))).status).toBe(200);
    expect((await run(claimRoute as any, jsonReq("POST", "/api/scheduled/claim", {}, { kind: "reminder_morning" }))).status).toBe(401);
    expect((await run(claimRoute as any, jsonReq("POST", "/api/scheduled/claim", auth, { kind: "bogus" }))).status).toBe(422);
    const bad = await claimRoute(new Request(`${ORIGIN}/api/scheduled/claim`, { method: "POST", headers: auth, body: "{nope" }));
    expect(bad.status).toBe(400);
  });

  it("the report endpoint accepts the scheduler token and still serves sessions", async () => {
    commit("2026-11-09", [4]);
    const viaToken = await run(reportRoute as any, jsonReq("GET", "/api/report?week=2026-11-09", auth));
    expect(viaToken.status).toBe(200);
    expect(viaToken.body.data.weekStart).toBe("2026-11-09");
    expect(viaToken.body.data.digest).toBeUndefined();
    expect((await run(reportRoute as any, jsonReq("GET", "/api/report?week=2026-11-09"))).status).toBe(401);
    expect((await run(reportRoute as any, jsonReq("GET", "/api/report?week=2026-11-09", { "x-reminder-token": "wrong-token-wrong-token" }))).status).toBe(401);
    expect((await run(reportRoute as any, jsonReq("GET", "/api/report?week=2026-11-10", auth))).status).toBe(400);
    expect((await run(reportRoute as any, jsonReq("GET", "/api/report?week=2026-12-07", auth))).status).toBe(422);
  });

  it("digest=1 returns the ready-made digest text", async () => {
    process.env.VL_TEST_NOW = FRI_1730.toISOString();
    fridayWeek({ closeFriday: false });
    const r = await run(reportRoute as any, jsonReq("GET", "/api/report?week=2026-11-09&digest=1", auth));
    expect(r.status).toBe(200);
    expect(r.body.data.digest.snapshot.isSnapshot).toBe(true);
    expect(r.body.data.digest.text).toContain("SNAPSHOT as of 5:30 PM Asia/Kolkata");
  });

  it("an unavailable report backend yields a clean 500 with no internals, and the flow can then report failure", async () => {
    globalThis.__vlDb = new Proxy({}, { get: () => { throw new Error("db exploded at /secret/path with token"); } }) as never;
    const errSpy = console.error;
    console.error = () => {};
    try {
      const r = await run(reportRoute as any, jsonReq("GET", "/api/report", auth));
      expect(r.status).toBe(500);
      expect(JSON.stringify(r.body)).not.toMatch(/exploded|secret|path|token|stack/i);
    } finally {
      console.error = errSpy;
    }
    globalThis.__vlDb = w.db;
    claim("reminder_morning", MON_1030);
    const f = await run(confirmRoute as any, jsonReq("POST", "/api/scheduled/confirm", auth, { eventId: "reminder_morning:2026-11-09", ok: false, error: "report_unavailable" }));
    expect(f.body.data).toEqual({ status: "failed" });
  });
});
