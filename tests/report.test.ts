import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { auditLog, reviews } from "@/db/schema";
import { addOutcome, closeDay, closeOutcome, commitDay, logUnplanned, putGoals, type Cfg } from "@/lib/ledger";
import { getReport } from "@/lib/report";
import { dayReportText, weekReportText } from "@/lib/report-text";
import { putDayNote, putReview } from "@/lib/reviews";
import { addDays } from "@/lib/time";
import { makeWorld, MON_0930, type World } from "./helpers";

const cfg: Cfg = { tz: "Asia/Kolkata", commitByHour: 11 };
const WEEK = "2026-11-09";
const NOW = new Date("2026-11-09T13:00:00Z"); // Monday evening IST
let w: World;
beforeEach(async () => {
  w = await makeWorld();
});

type Plan = { level: number; fate: "done" | "missed" | "carried"; goalId?: number };

/** Plan + commit at 09:30 IST, close each outcome, optionally log unplanned work, close the day. */
function runDay(date: string, plan: Plan[], opts: { closeNextDay?: boolean; unplannedLevel?: number } = {}) {
  const at = new Date(`${date}T04:00:00Z`);
  const eve = new Date(`${date}T12:30:00Z`);
  const ids = plan.map(
    (p, i) =>
      addOutcome(w.db, w.owner, date, { title: `Outcome ${date} #${i + 1}`, doneMeans: "Checkable result", level: p.level, goalId: p.goalId }, at, cfg).id,
  );
  commitDay(w.db, w.owner, date, at, cfg);
  plan.forEach((p, i) => {
    const input =
      p.fate === "done"
        ? { status: "done", proofUrl: `https://example.com/${date}/${i}`, result: `Result ${i}` }
        : { status: p.fate, reason: "because" };
    closeOutcome(w.db, w.owner, ids[i]!, input, eve, cfg);
  });
  let unplannedId: number | undefined;
  if (opts.unplannedLevel) {
    unplannedId = logUnplanned(w.db, w.owner, date, { title: "Urgent fire", level: opts.unplannedLevel, result: "Fixed", proofUrl: "https://example.com/incident" }, eve, cfg).id;
  }
  const closeAt = opts.closeNextDay ? new Date(`${addDays(date, 1)}T05:00:00Z`) : eve;
  closeDay(w.db, w.owner, date, { highlight: `Highlight ${date}` }, closeAt, cfg);
  return { ids, unplannedId };
}
const report = (week = WEEK, now = NOW) => getReport(w.db, week, now, cfg);
const audits = () => w.db.select().from(auditLog).all();

describe("reviewer authorization", () => {
  it("only reviewers can write reviews and notes: owner 403, anonymous 401", () => {
    const { ids } = runDay(WEEK, [{ level: 4, fate: "done" }]);
    for (const actor of [w.owner, null]) {
      const status = actor ? 403 : 401;
      expect(() => putReview(w.db, actor, ids[0]!, { confirmedPoints: 8 }, NOW)).toThrowError(expect.objectContaining({ status }));
      expect(() => putDayNote(w.db, actor, WEEK, { note: "hi" }, NOW)).toThrowError(expect.objectContaining({ status }));
    }
    expect(w.db.select().from(reviews).all()).toHaveLength(0);
  });
});

describe("putReview validation", () => {
  it("accepts only 0,1,2,4,8", () => {
    const { ids } = runDay(WEEK, [{ level: 4, fate: "done" }]);
    for (const confirmedPoints of [3, 5, 16, -1, "4", null, 2.5]) {
      expect(() => putReview(w.db, w.reviewer, ids[0]!, { confirmedPoints }, NOW)).toThrowError(expect.objectContaining({ status: 422 }));
    }
    for (const confirmedPoints of [0, 1, 2, 4, 8]) {
      expect(() => putReview(w.db, w.reviewer, ids[0]!, { confirmedPoints }, NOW)).not.toThrow();
    }
  });

  it("refuses unknown ids (404), undelivered outcomes (422), and days not yet closed (409)", () => {
    const { ids } = runDay(WEEK, [{ level: 4, fate: "done" }, { level: 2, fate: "missed" }]);
    expect(() => putReview(w.db, w.reviewer, 999, { confirmedPoints: 1 }, NOW)).toThrowError(expect.objectContaining({ status: 404 }));
    expect(() => putReview(w.db, w.reviewer, ids[1]!, { confirmedPoints: 1 }, NOW)).toThrowError(expect.objectContaining({ code: "not_delivered" }));

    const tue = "2026-11-10";
    const at = new Date(`${tue}T04:00:00Z`);
    const o = addOutcome(w.db, w.owner, tue, { title: "t", doneMeans: "d", level: 2 }, at, cfg);
    commitDay(w.db, w.owner, tue, at, cfg);
    closeOutcome(w.db, w.owner, o.id, { status: "done", proofUrl: "https://a.b/c", result: "r" }, at, cfg);
    expect(() => putReview(w.db, w.reviewer, o.id, { confirmedPoints: 2 }, at)).toThrowError(expect.objectContaining({ status: 409, code: "day_not_closed" }));
  });

  it("rejects extra fields", () => {
    const { ids } = runDay(WEEK, [{ level: 4, fate: "done" }]);
    expect(() => putReview(w.db, w.reviewer, ids[0]!, { confirmedPoints: 4, outcomeId: 1 }, NOW)).toThrowError(expect.objectContaining({ status: 422 }));
  });
});

describe("report calculations", () => {
  it("before review, everything is awaiting and claim accuracy is unavailable", () => {
    runDay(WEEK, [{ level: 8, fate: "done" }, { level: 2, fate: "done" }]);
    const r = report();
    expect(r.value).toEqual({ confirmed: 0, awaiting: 10, total: 10 });
    expect(r.status).toBe("awaiting");
    expect(r.measures.claimAccuracy.percent).toBeNull();
    expect(r.measures.promisesKept.percent).toBe(100);
    expect(r.circles.every((c) => c.state === "awaiting")).toBe(true);
  });

  it("confirmed points flow into every measure and the headline split", () => {
    const [g] = putGoals(w.db, w.owner, WEEK, { goals: [{ text: "Launch", measure: "m" }] }, MON_0930, cfg);
    const { ids, unplannedId } = runDay(WEEK, [{ level: 8, fate: "done", goalId: g!.id }, { level: 2, fate: "done" }], { unplannedLevel: 4 });
    // before: 8 + 2 + 4 = 14 awaiting
    expect(report().value).toEqual({ confirmed: 0, awaiting: 14, total: 14 });
    putReview(w.db, w.reviewer, ids[0]!, { confirmedPoints: 4 }, NOW); // 8 → 4
    const r = report();
    expect(r.value).toEqual({ confirmed: 4, awaiting: 6, total: 10 });
    expect(r.status).toBe("partly");
    expect(r.measures.claimAccuracy.percent).toBe(50); // 4 ÷ 8, reviewed only
    expect(r.measures.promisesKept.percent).toBe(100); // uses claimed points: reviewers don't change reliability
    expect(r.measures.onGoal.percent).toBe(40); // 4 of 10
    expect(r.measures.highLeverageShare.percent).toBe(80); // 4 + 4 of 10
    expect(r.measures.unplannedShare.percent).toBe(40); // 4 of 10
    putReview(w.db, w.reviewer, ids[1]!, { confirmedPoints: 2 }, NOW);
    putReview(w.db, w.reviewer, unplannedId!, { confirmedPoints: 4 }, NOW);
    const full = report();
    expect(full.status).toBe("reviewed");
    expect(full.value).toEqual({ confirmed: 10, awaiting: 0, total: 10 });
    expect(full.measures.claimAccuracy.percent).toBe(71); // 10 ÷ 14
  });

  it("claim accuracy exceeds 100% when the reviewer raises a score", () => {
    const { ids } = runDay(WEEK, [{ level: 1, fate: "done" }]);
    putReview(w.db, w.reviewer, ids[0]!, { confirmedPoints: 8 }, NOW);
    expect(report().measures.claimAccuracy.percent).toBe(800);
  });

  it("a reviewer score of zero is confirmed, adds no value, and keeps the circle visible", () => {
    const { ids } = runDay(WEEK, [{ level: 8, fate: "done" }, { level: 2, fate: "done" }]);
    putReview(w.db, w.reviewer, ids[0]!, { confirmedPoints: 0 }, NOW);
    const r = report();
    expect(r.value).toEqual({ confirmed: 0, awaiting: 2, total: 2 });
    const zero = r.circles.find((c) => c.id === ids[0])!;
    expect(zero).toMatchObject({ state: "confirmed", points: 0, claimed: 8 });
    expect(r.measures.claimAccuracy.percent).toBe(0);
    expect(r.measures.promisesKept.percent).toBe(100);
    const day = r.days[0]!.outcomes.find((o) => o.id === ids[0])!;
    expect(day).toMatchObject({ state: "confirmed", points: 0, confirmedPoints: 0 });
  });

  it("zeroing everything makes the share measures unavailable (null), never NaN or 100%", () => {
    const { ids } = runDay(WEEK, [{ level: 8, fate: "done" }]);
    putReview(w.db, w.reviewer, ids[0]!, { confirmedPoints: 0 }, NOW);
    const m = report().measures;
    expect(m.highLeverageShare.percent).toBeNull();
    expect(m.onGoal.percent).toBeNull();
    expect(m.unplannedShare.percent).toBeNull();
    expect(m.claimAccuracy.percent).toBe(0);
  });

  it("an empty week has every measure unavailable and status 'nothing'", () => {
    const r = report();
    expect(r.status).toBe("nothing");
    expect(r.value).toEqual({ confirmed: 0, awaiting: 0, total: 0 });
    for (const m of Object.values(r.measures)) expect(m.percent).toBeNull();
    expect(r.circles).toEqual([]);
    expect(r.days).toEqual([]);
    expect(JSON.stringify(r)).not.toMatch(/NaN|Infinity/);
  });

  it("a week where everything was missed: promises kept is 0%, shares unavailable", () => {
    runDay(WEEK, [{ level: 4, fate: "missed" }, { level: 8, fate: "carried" }]);
    const m = report().measures;
    expect(m.promisesKept.percent).toBe(0);
    expect(m.highLeverageShare.percent).toBeNull();
  });

  it("unplanned work never inflates promises kept", () => {
    runDay(WEEK, [{ level: 2, fate: "missed" }], { unplannedLevel: 8 });
    const r = report();
    expect(r.measures.promisesKept.percent).toBe(0);
    expect(r.measures.unplannedShare.percent).toBe(100);
  });

  it("a later review replaces an earlier one (latest wins)", () => {
    const { ids } = runDay(WEEK, [{ level: 4, fate: "done" }]);
    putReview(w.db, w.reviewer, ids[0]!, { confirmedPoints: 1 }, NOW);
    putReview(w.db, w.reviewer, ids[0]!, { confirmedPoints: 8 }, new Date(NOW.getTime() + 60_000));
    expect(report().value).toEqual({ confirmed: 8, awaiting: 0, total: 8 });
  });

  it("rhythm: on-time commit and same-day close vs closing a day late", () => {
    runDay("2026-11-09", [{ level: 2, fate: "done" }]);
    expect(report().measures.rhythm.percent).toBe(100);
    runDay("2026-11-10", [{ level: 2, fate: "done" }], { closeNextDay: true });
    expect(getReport(w.db, WEEK, new Date("2026-11-11T05:00:00Z"), cfg).measures.rhythm.percent).toBe(75); // (2 + 1) ÷ 4
  });

  it("draft (uncommitted) outcomes are not part of the report", () => {
    addOutcome(w.db, w.owner, "2026-11-10", { title: "Draft", doneMeans: "d", level: 8 }, NOW, cfg);
    expect(report().days).toEqual([]);
  });

  it("validates the week parameter", () => {
    expect(() => report("2026-11-10")).toThrowError(expect.objectContaining({ status: 400 }));
    expect(() => report("nope")).toThrowError(expect.objectContaining({ status: 400 }));
    expect(() => report("2026-11-16")).toThrowError(expect.objectContaining({ code: "future_week" }));
    expect(getReport(w.db, undefined, NOW, cfg).weekStart).toBe(WEEK);
  });

  it("only exposes valid http(s) proof links", () => {
    const { ids } = runDay(WEEK, [{ level: 2, fate: "done" }]);
    expect(report().days[0]!.outcomes.find((o) => o.id === ids[0])!.proofUrl).toBe(`https://example.com/${WEEK}/0`);
    w.db.run(sql`update outcomes set proof_url = 'javascript:alert(1)' where id = ${ids[0]}`);
    expect(report().days[0]!.outcomes.find((o) => o.id === ids[0])!.proofUrl).toBeNull(); // never rendered as a link
  });
});

describe("eight-week chart data", () => {
  it("returns eight weeks oldest→newest ending at the selected week, split by level and review state", () => {
    // week of 2026-10-26 (two weeks earlier): an 8 and a 1; this week: a 4
    const prior = "2026-10-26";
    const a = runDay(prior, [{ level: 8, fate: "done" }, { level: 1, fate: "done" }]).ids;
    putReview(w.db, w.reviewer, a[0]!, { confirmedPoints: 8 }, new Date(`${prior}T14:00:00Z`));
    runDay(WEEK, [{ level: 4, fate: "done" }]);
    const bars = report().eightWeeks;
    expect(bars).toHaveLength(8);
    expect(bars.map((b) => b.weekStart)).toEqual(["2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02", "2026-11-09"]);
    const old = bars[5]!;
    expect(old.byLevel[8]).toEqual({ confirmed: 8, awaiting: 0 });
    expect(old.byLevel[1]).toEqual({ confirmed: 0, awaiting: 1 });
    expect(old).toMatchObject({ confirmed: 8, awaiting: 1, total: 9 });
    expect(bars[6]!.total).toBe(0);
    expect(bars[7]!.byLevel[4]).toEqual({ confirmed: 0, awaiting: 4 });
  });

  it("buckets by effective level: a reviewer lowering an 8 to a 2 moves it to the 2 bar; zero vanishes", () => {
    const { ids } = runDay(WEEK, [{ level: 8, fate: "done" }, { level: 4, fate: "done" }]);
    putReview(w.db, w.reviewer, ids[0]!, { confirmedPoints: 2 }, NOW);
    putReview(w.db, w.reviewer, ids[1]!, { confirmedPoints: 0 }, NOW);
    const last = report().eightWeeks[7]!;
    expect(last.byLevel[2]).toEqual({ confirmed: 2, awaiting: 0 });
    expect(last.byLevel[8]).toEqual({ confirmed: 0, awaiting: 0 });
    expect(last.byLevel[4]).toEqual({ confirmed: 0, awaiting: 0 });
    expect(last.total).toBe(2);
  });

  it("an empty history yields eight zero bars", () => {
    const bars = report().eightWeeks;
    expect(bars).toHaveLength(8);
    expect(bars.every((b) => b.total === 0)).toBe(true);
  });

  it("splitting work does not raise a bar: eight upkeep points equal one multiplier", () => {
    runDay("2026-11-02", [{ level: 1, fate: "done" }, { level: 1, fate: "done" }, { level: 1, fate: "done" }]);
    runDay(WEEK, [{ level: 8, fate: "done" }]);
    const bars = report().eightWeeks;
    expect(bars[6]!.total).toBe(3);
    expect(bars[7]!.total).toBe(8);
  });
});

describe("weekly goal progress", () => {
  it("shows points toward each goal and their share of the week", () => {
    const [g1, g2] = putGoals(
      w.db,
      w.owner,
      WEEK,
      { goals: [{ text: "Launch", measure: "m1" }, { text: "Docs", measure: "m2" }] },
      MON_0930,
      cfg,
    );
    const { ids } = runDay(WEEK, [{ level: 8, fate: "done", goalId: g1!.id }, { level: 2, fate: "done" }]);
    putReview(w.db, w.reviewer, ids[0]!, { confirmedPoints: 4 }, NOW);
    const [a, b] = report().goals;
    expect(a).toMatchObject({ id: g1!.id, confirmed: 4, awaiting: 0, total: 4, sharePercent: 67 });
    expect(b).toMatchObject({ id: g2!.id, total: 0, sharePercent: 0 });
  });
  it("share is unavailable when nothing is delivered", () => {
    putGoals(w.db, w.owner, WEEK, { goals: [{ text: "Launch", measure: "m" }] }, MON_0930, cfg);
    expect(report().goals[0]!.sharePercent).toBeNull();
  });
});

describe("day by day", () => {
  it("lists newest first with promised vs delivered, evidence and reviewer notes", () => {
    runDay("2026-11-09", [{ level: 8, fate: "done" }, { level: 2, fate: "missed" }]);
    runDay("2026-11-10", [{ level: 4, fate: "done" }]);
    putDayNote(w.db, w.reviewer, "2026-11-09", { note: "Good week start" }, NOW);
    const days = getReport(w.db, WEEK, new Date("2026-11-10T13:00:00Z"), cfg).days;
    expect(days.map((d) => d.date)).toEqual(["2026-11-10", "2026-11-09"]);
    const mon = days[1]!;
    expect(mon).toMatchObject({ promisedPoints: 10, keptPoints: 8, highlight: "Highlight 2026-11-09" });
    expect(mon.notes).toEqual([{ reviewer: "Ravi Reviewer", note: "Good week start", updatedAt: NOW.toISOString() }]);
    expect(mon.outcomes[0]!.proofUrl).toBe("https://example.com/2026-11-09/0");
  });
});

describe("audit logging of reviewer changes", () => {
  it("records create and update with actor, before and after; no-ops are not logged", () => {
    const { ids } = runDay(WEEK, [{ level: 4, fate: "done" }]);
    const base = audits().length;
    putReview(w.db, w.reviewer, ids[0]!, { confirmedPoints: 2 }, NOW);
    putReview(w.db, w.reviewer, ids[0]!, { confirmedPoints: 2 }, NOW); // unchanged → no entry
    putReview(w.db, w.reviewer, ids[0]!, { confirmedPoints: 8 }, new Date(NOW.getTime() + 1000));
    const rows = audits().slice(base);
    expect(rows.map((r) => [r.action, r.actorId, r.entity])).toEqual([
      ["review.create", w.reviewer.id, "review"],
      ["review.update", w.reviewer.id, "review"],
    ]);
    expect(JSON.parse(rows[0]!.beforeJson!)).toMatchObject({ outcomeId: ids[0], claimedLevel: 4 });
    expect(JSON.parse(rows[0]!.afterJson!).confirmedPoints).toBe(2);
    expect(JSON.parse(rows[1]!.beforeJson!).confirmedPoints).toBe(2);
    expect(JSON.parse(rows[1]!.afterJson!).confirmedPoints).toBe(8);
  });

  it("records day notes, and a rejected review writes nothing", () => {
    const { ids } = runDay(WEEK, [{ level: 4, fate: "done" }]);
    const base = audits().length;
    putDayNote(w.db, w.reviewer, WEEK, { note: "First" }, NOW);
    putDayNote(w.db, w.reviewer, WEEK, { note: "Second" }, new Date(NOW.getTime() + 1000));
    expect(() => putReview(w.db, w.reviewer, ids[0]!, { confirmedPoints: 3 }, NOW)).toThrow();
    const rows = audits().slice(base);
    expect(rows.map((r) => r.action)).toEqual(["day_note.create", "day_note.update"]);
    expect(JSON.parse(rows[1]!.beforeJson!).note).toBe("First");
    expect(JSON.parse(rows[1]!.afterJson!).note).toBe("Second");
  });

  it("day notes need an existing day and non-empty text", () => {
    expect(() => putDayNote(w.db, w.reviewer, "2026-11-03", { note: "x" }, NOW)).toThrowError(expect.objectContaining({ status: 404 }));
    runDay(WEEK, [{ level: 4, fate: "done" }]);
    expect(() => putDayNote(w.db, w.reviewer, WEEK, { note: "   " }, NOW)).toThrowError(expect.objectContaining({ status: 422 }));
    expect(() => putDayNote(w.db, w.reviewer, "bad", { note: "x" }, NOW)).toThrowError(expect.objectContaining({ status: 400 }));
  });
});

describe("report text for copying", () => {
  it("day report lists actual outcomes, value, verification status and evidence", () => {
    const { ids } = runDay(WEEK, [{ level: 8, fate: "done" }, { level: 2, fate: "missed" }], { unplannedLevel: 4 });
    putReview(w.db, w.reviewer, ids[0]!, { confirmedPoints: 4 }, NOW);
    putDayNote(w.db, w.reviewer, WEEK, { note: "Solid." }, NOW);
    const text = dayReportText(report().days[0]!, "Olive Owner");
    expect(text).toContain("Day report · Olive Owner");
    expect(text).toContain("Monday, 9 November 2026");
    expect(text).toContain("Value delivered: 8 points (4 confirmed + 4 awaiting review)");
    expect(text).toContain("Confirmed by reviewer: 4 points (claimed 8)");
    expect(text).toContain("Awaiting review (claimed 4)");
    expect(text).toContain("Actual: Result 0");
    expect(text).toContain("Evidence: https://example.com/2026-11-09/0");
    expect(text).toContain("Missed: because");
    expect(text).toContain("UNPLANNED (not counted in promises kept)");
    expect(text).toContain("Reviewer note (Ravi Reviewer): Solid.");
    expect(text).not.toMatch(/\b(tasks?|NaN|undefined|null)\b/i);
  });

  it("week report carries headline, six measures, goals and the day log; unavailable measures say so", () => {
    putGoals(w.db, w.owner, WEEK, { goals: [{ text: "Launch", measure: "Published" }] }, MON_0930, cfg);
    runDay(WEEK, [{ level: 4, fate: "done" }]);
    const text = weekReportText(report(), "Olive Owner");
    expect(text).toContain("Week report · Olive Owner");
    expect(text).toContain("Value delivered: 4 points — 0 confirmed plus 4 awaiting review");
    expect(text).toContain("Review status: Awaiting review");
    expect(text).toContain("• Claim accuracy: not available yet");
    expect(text).toContain("• Promises kept: 100%");
    expect(text).toContain("Launch (measured by: Published)");
    expect(text).toContain("Evidence: https://example.com/2026-11-09/0");
    expect(weekReportText(getReport(w.db, "2026-11-02", NOW, cfg))).toContain("Review status: Nothing delivered yet");
  });

  it("scores zero by the reviewer are labelled as such", () => {
    const { ids } = runDay(WEEK, [{ level: 8, fate: "done" }]);
    putReview(w.db, w.reviewer, ids[0]!, { confirmedPoints: 0 }, NOW);
    expect(dayReportText(report().days[0]!)).toContain("Scored 0 by reviewer (claimed 8)");
  });
});
