import { beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { auditLog, days, goals, outcomes } from "@/db/schema";
import {
  addOutcome,
  closeDay,
  closeOutcome,
  commitDay,
  deleteDraftOutcome,
  getMyDay,
  logUnplanned,
  putGoals,
  updateDraftOutcome,
  type Cfg,
} from "@/lib/ledger";
import { addDays, localDate, weekStartOf, zonedInstant } from "@/lib/time";
import { dbErrorMessage, makeWorld, MON_0930, type World } from "./helpers";

const cfg: Cfg = { tz: "Asia/Kolkata", commitByHour: 11 };
const TODAY = "2026-11-09";
const TOMORROW = "2026-11-10";
const WEEK = "2026-11-09";
const input = (o: Record<string, unknown> = {}) => ({ title: "Ship the plug", doneMeans: "Published with 10 actions", level: 4, ...o });
const proof = { status: "done", proofUrl: "https://example.com/proof", result: "Published; 10 actions live." };

let w: World;
beforeEach(async () => {
  w = await makeWorld();
});

const plan = (date = TODAY, n = 1, now = MON_0930) =>
  Array.from({ length: n }, (_, i) => addOutcome(w.db, w.owner, date, input({ title: `Outcome ${i + 1}` }), now, cfg));
const audits = () => w.db.select().from(auditLog).all();
const actions = () => audits().map((a) => a.action);

describe("planning rules", () => {
  it("adds up to three outcomes and rejects the fourth (422)", () => {
    plan(TODAY, 3);
    expect(() => addOutcome(w.db, w.owner, TODAY, input(), MON_0930, cfg)).toThrowError(
      expect.objectContaining({ status: 422, code: "outcome_limit" }),
    );
    expect(w.db.select().from(outcomes).all()).toHaveLength(3);
  });

  it("rejects an invalid value level (422)", () => {
    for (const level of [0, 3, 5, 16, "4", null]) {
      expect(() => addOutcome(w.db, w.owner, TODAY, input({ level }), MON_0930, cfg)).toThrowError(
        expect.objectContaining({ status: 422, code: "validation_failed" }),
      );
    }
  });

  it("rejects unknown fields and blank text", () => {
    expect(() => addOutcome(w.db, w.owner, TODAY, input({ status: "done" }), MON_0930, cfg)).toThrowError(expect.objectContaining({ status: 422 }));
    expect(() => addOutcome(w.db, w.owner, TODAY, input({ title: "   " }), MON_0930, cfg)).toThrowError(expect.objectContaining({ status: 422 }));
  });

  it("rejects planning a past day, and anything beyond tomorrow", () => {
    expect(() => addOutcome(w.db, w.owner, "2026-11-08", input(), MON_0930, cfg)).toThrowError(expect.objectContaining({ status: 422, code: "past_day" }));
    expect(() => commitDay(w.db, w.owner, "2026-11-08", MON_0930, cfg)).toThrowError(expect.objectContaining({ code: "past_day" }));
    expect(() => addOutcome(w.db, w.owner, "2026-11-11", input(), MON_0930, cfg)).toThrowError(expect.objectContaining({ code: "too_far_ahead" }));
    expect(() => addOutcome(w.db, w.owner, "nope", input(), MON_0930, cfg)).toThrowError(expect.objectContaining({ status: 400 }));
    expect(() => addOutcome(w.db, w.owner, "2026-02-30", input(), MON_0930, cfg)).toThrowError(expect.objectContaining({ status: 400 }));
  });

  it("can plan tomorrow", () => {
    expect(plan(TOMORROW)).toHaveLength(1);
  });

  it("links a goal only from the same week", () => {
    const [g] = putGoals(w.db, w.owner, WEEK, { goals: [{ text: "Launch", measure: "Published" }] }, MON_0930, cfg);
    expect(addOutcome(w.db, w.owner, TODAY, input({ goalId: g!.id }), MON_0930, cfg).goalId).toBe(g!.id);
    expect(() => addOutcome(w.db, w.owner, TODAY, input({ goalId: 999 }), MON_0930, cfg)).toThrowError(expect.objectContaining({ code: "unknown_goal" }));
    // tomorrow is still the same week (Tue) — fine; next week's goal is wrong-week for today
    const [g2] = putGoals(w.db, w.owner, "2026-11-16", { goals: [{ text: "Later", measure: "m" }] }, MON_0930, cfg);
    expect(() => addOutcome(w.db, w.owner, TODAY, input({ goalId: g2!.id }), MON_0930, cfg)).toThrowError(expect.objectContaining({ code: "goal_wrong_week" }));
  });
});

describe("commit, lock and deadline", () => {
  it("commit stamps the server time and locks the plan", () => {
    plan(TODAY, 2);
    const d = commitDay(w.db, w.owner, TODAY, MON_0930, cfg);
    expect(d.lockedAt).toBe(MON_0930.toISOString());
  });

  it("refuses an empty plan and a double commit", () => {
    expect(() => commitDay(w.db, w.owner, TODAY, MON_0930, cfg)).toThrowError(expect.objectContaining({ status: 422, code: "empty_plan" }));
    plan();
    commitDay(w.db, w.owner, TODAY, MON_0930, cfg);
    expect(() => commitDay(w.db, w.owner, TODAY, MON_0930, cfg)).toThrowError(expect.objectContaining({ status: 409, code: "already_committed" }));
  });

  it("locked outcomes cannot be edited, deleted, or added to", () => {
    const [o] = plan(TODAY, 1);
    commitDay(w.db, w.owner, TODAY, MON_0930, cfg);
    expect(() => updateDraftOutcome(w.db, w.owner, o!.id, { level: 8 }, MON_0930)).toThrowError(expect.objectContaining({ status: 409, code: "outcome_locked" }));
    expect(() => deleteDraftOutcome(w.db, w.owner, o!.id, MON_0930)).toThrowError(expect.objectContaining({ code: "outcome_locked" }));
    expect(() => addOutcome(w.db, w.owner, TODAY, input(), MON_0930, cfg)).toThrowError(expect.objectContaining({ status: 409, code: "day_locked" }));
  });

  it("the database itself also refuses edits/deletes of locked outcomes (defence in depth)", () => {
    const [o] = plan(TODAY, 1);
    commitDay(w.db, w.owner, TODAY, MON_0930, cfg);
    expect(dbErrorMessage(() => w.db.run(sql`update outcomes set level = 8 where id = ${o!.id}`))).toMatch(/locked/);
    expect(dbErrorMessage(() => w.db.run(sql`delete from outcomes where id = ${o!.id}`))).toMatch(/locked/);
    expect(dbErrorMessage(() => w.db.run(sql`update days set locked_at = null where date = ${TODAY}`))).toMatch(/immutable/);
  });

  it("drafts can still be edited and deleted before commit", () => {
    const [o] = plan(TODAY, 1);
    expect(updateDraftOutcome(w.db, w.owner, o!.id, { level: 8, title: "Bigger" }, MON_0930).level).toBe(8);
    deleteDraftOutcome(w.db, w.owner, o!.id, MON_0930);
    expect(w.db.select().from(outcomes).all()).toHaveLength(0);
  });

  describe("India timezone and the 11:00 cutoff", () => {
    const at = (iso: string) => new Date(iso);
    it("10:59:59.999 IST is on time; 11:00:00.000 IST is late", () => {
      plan(TODAY, 1);
      expect(zonedInstant(TODAY, 11, "Asia/Kolkata").toISOString()).toBe("2026-11-09T05:30:00.000Z");
      const onTime = at("2026-11-09T05:29:59.999Z");
      expect(commitDay(w.db, w.owner, TODAY, onTime, cfg).lockedAt).toBe(onTime.toISOString());
    });
    it("exactly 11:00:00.000 IST is rejected, nothing is silently backdated", () => {
      plan(TODAY, 1);
      expect(() => commitDay(w.db, w.owner, TODAY, at("2026-11-09T05:30:00.000Z"), cfg)).toThrowError(
        expect.objectContaining({ status: 409, code: "deadline_passed" }),
      );
      expect(w.db.select().from(days).get()?.lockedAt).toBeNull();
    });
    it("a late attempt is not recorded as a commit; tomorrow can still be committed at any time today", () => {
      plan(TOMORROW, 1, at("2026-11-09T12:00:00Z"));
      expect(commitDay(w.db, w.owner, TOMORROW, at("2026-11-09T12:00:00Z"), cfg).lockedAt).toBeTruthy();
    });
    it("the 'today' boundary follows India midnight, not UTC", () => {
      expect(localDate(at("2026-11-08T18:29:59Z"), "Asia/Kolkata")).toBe("2026-11-08");
      expect(localDate(at("2026-11-08T18:30:00Z"), "Asia/Kolkata")).toBe("2026-11-09");
      // 23:45 IST Sunday: Sunday is today, Monday is tomorrow, Sunday-before is past
      const sunLate = at("2026-11-08T18:15:00Z");
      expect(() => addOutcome(w.db, w.owner, "2026-11-08", input(), sunLate, cfg)).not.toThrow();
      expect(() => addOutcome(w.db, w.owner, "2026-11-07", input(), sunLate, cfg)).toThrowError(expect.objectContaining({ code: "past_day" }));
    });
    it("weeks start on Monday", () => {
      expect(weekStartOf("2026-11-15")).toBe("2026-11-09"); // Sunday
      expect(weekStartOf("2026-11-09")).toBe("2026-11-09");
      expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    });
    it("honours a configured commit hour", () => {
      plan(TODAY, 1);
      const early: Cfg = { tz: "Asia/Kolkata", commitByHour: 9 };
      expect(() => commitDay(w.db, w.owner, TODAY, MON_0930, early)).toThrowError(expect.objectContaining({ code: "deadline_passed" }));
    });
  });
});

describe("closing outcomes", () => {
  let ids: number[];
  beforeEach(() => {
    ids = plan(TODAY, 3).map((o) => o.id);
    commitDay(w.db, w.owner, TODAY, MON_0930, cfg);
  });

  it("done requires a valid http/https proof URL (422)", () => {
    for (const proofUrl of [undefined, "", "   ", "ftp://x.y", "javascript:alert(1)", "not a url"]) {
      expect(() => closeOutcome(w.db, w.owner, ids[0]!, { status: "done", proofUrl, result: "x" }, MON_0930, cfg)).toThrowError(
        expect.objectContaining({ status: 422 }),
      );
    }
  });

  it("done requires a non-empty result note (422)", () => {
    expect(() => closeOutcome(w.db, w.owner, ids[0]!, { status: "done", proofUrl: "https://a.b/c", result: "  " }, MON_0930, cfg)).toThrowError(
      expect.objectContaining({ status: 422 }),
    );
    expect(w.db.select().from(outcomes).all()[0]!.status).toBe("open");
  });

  it("done records proof, result and the server timestamp", () => {
    const later = new Date("2026-11-09T09:00:00Z");
    const r = closeOutcome(w.db, w.owner, ids[0]!, proof, later, cfg);
    expect(r.outcome).toMatchObject({ status: "done", proofUrl: "https://example.com/proof", closedAt: later.toISOString() });
  });

  it("missed and carried require a reason", () => {
    expect(() => closeOutcome(w.db, w.owner, ids[0]!, { status: "missed" }, MON_0930, cfg)).toThrowError(expect.objectContaining({ status: 422 }));
    expect(() => closeOutcome(w.db, w.owner, ids[0]!, { status: "carried", reason: " " }, MON_0930, cfg)).toThrowError(expect.objectContaining({ status: 422 }));
    expect(closeOutcome(w.db, w.owner, ids[0]!, { status: "missed", reason: "Blocked on vendor" }, MON_0930, cfg).outcome.status).toBe("missed");
  });

  it("an outcome can be closed only once and cannot be re-edited", () => {
    closeOutcome(w.db, w.owner, ids[0]!, proof, MON_0930, cfg);
    expect(() => closeOutcome(w.db, w.owner, ids[0]!, { status: "missed", reason: "x" }, MON_0930, cfg)).toThrowError(
      expect.objectContaining({ status: 409, code: "outcome_not_open" }),
    );
  });

  it("unknown outcome is 404; draft (uncommitted) outcome cannot be closed", () => {
    expect(() => closeOutcome(w.db, w.owner, 9999, proof, MON_0930, cfg)).toThrowError(expect.objectContaining({ status: 404 }));
    const [draft] = plan(TOMORROW, 1);
    expect(() => closeOutcome(w.db, w.owner, draft!.id, proof, MON_0930, cfg)).toThrowError(expect.objectContaining({ code: "day_not_committed" }));
  });

  it("carry creates a fresh open outcome for tomorrow", () => {
    const r = closeOutcome(w.db, w.owner, ids[0]!, { status: "carried", reason: "Needs one more day" }, MON_0930, cfg);
    expect(r.outcome.status).toBe("carried");
    expect(r.carriedTo).toMatchObject({ date: TOMORROW, status: "open", carriedFrom: ids[0], planned: true, title: "Outcome 1" });
    expect(r.carriedTo!.closedAt).toBeNull();
  });

  it("carry when tomorrow is full: original is carried (scores zero), nothing created, owner is told", () => {
    plan(TOMORROW, 3);
    const r = closeOutcome(w.db, w.owner, ids[0]!, { status: "carried", reason: "No time" }, MON_0930, cfg);
    expect(r.outcome.status).toBe("carried");
    expect(r.carriedTo).toBeNull();
    expect(r.carryNote).toMatch(/full/i);
    expect(w.db.select().from(outcomes).all().filter((o) => o.date === TOMORROW)).toHaveLength(3);
  });

  it("carry when tomorrow is already committed: nothing created", () => {
    plan(TOMORROW, 1);
    commitDay(w.db, w.owner, TOMORROW, MON_0930, cfg);
    const r = closeOutcome(w.db, w.owner, ids[0]!, { status: "carried", reason: "No time" }, MON_0930, cfg);
    expect(r.carriedTo).toBeNull();
    expect(r.carryNote).toMatch(/committed/i);
  });

  it("carry is atomic: if creating tomorrow's outcome fails, the original stays open", () => {
    w.db.run(sql`create trigger fail_carry before insert on outcomes when new.carried_from is not null begin select raise(abort, 'boom'); end`);
    const before = audits().length;
    expect(() => closeOutcome(w.db, w.owner, ids[0]!, { status: "carried", reason: "Needs time" }, MON_0930, cfg)).toThrow();
    const o = w.db.select().from(outcomes).all().find((x) => x.id === ids[0])!;
    expect(o.status).toBe("open");
    expect(o.closedAt).toBeNull();
    expect(audits().length).toBe(before); // audit rolled back with it
    expect(w.db.select().from(days).all().map((d) => d.date)).toEqual([TODAY]); // no stray tomorrow row
  });

  it("an outcome of a future day cannot be closed early", () => {
    const [t] = plan(TOMORROW, 1);
    commitDay(w.db, w.owner, TOMORROW, MON_0930, cfg);
    expect(() => closeOutcome(w.db, w.owner, t!.id, proof, MON_0930, cfg)).toThrowError(expect.objectContaining({ code: "future_day" }));
  });
});

describe("unplanned work", () => {
  const un = { title: "Production fire", level: 4, result: "Restored service", proofUrl: "https://example.com/incident" };

  it("requires title, level, result and proof URL", () => {
    for (const bad of [{ title: "" }, { level: 3 }, { result: "" }, { proofUrl: "" }, { proofUrl: "javascript:1" }]) {
      expect(() => logUnplanned(w.db, w.owner, TODAY, { ...un, ...bad }, MON_0930, cfg)).toThrowError(expect.objectContaining({ status: 422 }));
    }
  });

  it("is stored as unplanned + done, only for today", () => {
    const o = logUnplanned(w.db, w.owner, TODAY, un, MON_0930, cfg);
    expect(o).toMatchObject({ planned: false, status: "done", level: 4 });
    expect(() => logUnplanned(w.db, w.owner, TOMORROW, un, MON_0930, cfg)).toThrowError(expect.objectContaining({ code: "future_day" }));
    expect(() => logUnplanned(w.db, w.owner, "2026-11-08", un, MON_0930, cfg)).toThrowError(expect.objectContaining({ code: "past_day" }));
  });

  it("does not count toward the three-outcome limit and never inflates promises kept", () => {
    plan(TODAY, 3);
    commitDay(w.db, w.owner, TODAY, MON_0930, cfg);
    logUnplanned(w.db, w.owner, TODAY, { ...un, level: 8 }, MON_0930, cfg);
    const v = getMyDay(w.db, TODAY, MON_0930, cfg);
    expect(v.summary.promisedPoints).toBe(12);
    expect(v.summary.promisesKept).toBe(0);
    expect(v.summary.deliveredPoints).toEqual({ confirmed: 0, awaiting: 8, total: 8 });
    expect(v.summary.unplannedPoints).toBe(8);
  });
});

describe("close the day", () => {
  const fin = { highlight: "Shipped the plug", learning: "Ask for review earlier" };

  it("is rejected while any committed outcome is open (409)", () => {
    const [a, b] = plan(TODAY, 2);
    commitDay(w.db, w.owner, TODAY, MON_0930, cfg);
    closeOutcome(w.db, w.owner, a!.id, proof, MON_0930, cfg);
    expect(() => closeDay(w.db, w.owner, TODAY, fin, MON_0930, cfg)).toThrowError(expect.objectContaining({ status: 409, code: "open_outcomes" }));
    closeOutcome(w.db, w.owner, b!.id, { status: "missed", reason: "Ran out of time" }, MON_0930, cfg);
    const d = closeDay(w.db, w.owner, TODAY, fin, new Date("2026-11-09T12:00:00Z"), cfg);
    expect(d).toMatchObject({ closedAt: "2026-11-09T12:00:00.000Z", highlight: "Shipped the plug", learning: "Ask for review earlier" });
  });

  it("requires the highlight; the learning is optional", () => {
    expect(() => closeDay(w.db, w.owner, TODAY, { highlight: "" }, MON_0930, cfg)).toThrowError(expect.objectContaining({ status: 422 }));
    expect(closeDay(w.db, w.owner, TODAY, { highlight: "Rest day" }, MON_0930, cfg).learning).toBeNull();
  });

  it("cannot close twice, a future day, or with an uncommitted draft plan", () => {
    plan(TODAY, 1);
    expect(() => closeDay(w.db, w.owner, TODAY, fin, MON_0930, cfg)).toThrowError(expect.objectContaining({ code: "uncommitted_plan" }));
    expect(() => closeDay(w.db, w.owner, TOMORROW, fin, MON_0930, cfg)).toThrowError(expect.objectContaining({ code: "future_day" }));
    const x = makeLogged();
    expect(x).toBeTruthy();
  });

  function makeLogged() {
    w.db.delete(outcomes).run();
    closeDay(w.db, w.owner, TODAY, fin, MON_0930, cfg);
    expect(() => closeDay(w.db, w.owner, TODAY, fin, MON_0930, cfg)).toThrowError(expect.objectContaining({ code: "day_closed" }));
    return true;
  }

  it("a closed day accepts no more unplanned work", () => {
    closeDay(w.db, w.owner, TODAY, fin, MON_0930, cfg);
    expect(() => logUnplanned(w.db, w.owner, TODAY, { title: "x", level: 1, result: "y", proofUrl: "https://a.b" }, MON_0930, cfg)).toThrowError(
      expect.objectContaining({ code: "day_closed" }),
    );
  });
});

describe("role authorization", () => {
  it("a reviewer gets 403 on every owner write; anonymous gets 401", () => {
    const [o] = plan(TODAY, 1);
    const writes: Array<(a: typeof w.reviewer | null) => unknown> = [
      (a) => addOutcome(w.db, a, TODAY, input(), MON_0930, cfg),
      (a) => commitDay(w.db, a, TODAY, MON_0930, cfg),
      (a) => closeOutcome(w.db, a, o!.id, proof, MON_0930, cfg),
      (a) => closeDay(w.db, a, TODAY, { highlight: "x" }, MON_0930, cfg),
      (a) => logUnplanned(w.db, a, TODAY, { title: "x", level: 1, result: "y", proofUrl: "https://a.b" }, MON_0930, cfg),
      (a) => updateDraftOutcome(w.db, a, o!.id, { level: 1 }, MON_0930),
      (a) => deleteDraftOutcome(w.db, a, o!.id, MON_0930),
    ];
    for (const f of writes) {
      expect(() => f(w.reviewer)).toThrowError(expect.objectContaining({ status: 403 }));
      expect(() => f(null)).toThrowError(expect.objectContaining({ status: 401 }));
    }
    expect(w.db.select().from(outcomes).all()).toHaveLength(1);
  });
});

describe("weekly goals", () => {
  const g = (text: string) => ({ text, measure: "Published with 10 actions" });

  it("allows up to three goals; a fourth is rejected", () => {
    expect(putGoals(w.db, w.owner, WEEK, { goals: [g("a"), g("b"), g("c")] }, MON_0930, cfg)).toHaveLength(3);
    expect(() => putGoals(w.db, w.owner, WEEK, { goals: [g("a"), g("b"), g("c"), g("d")] }, MON_0930, cfg)).toThrowError(expect.objectContaining({ status: 422 }));
  });

  it("requires a Monday and rejects past weeks", () => {
    expect(() => putGoals(w.db, w.owner, "2026-11-10", { goals: [] }, MON_0930, cfg)).toThrowError(expect.objectContaining({ status: 400 }));
    expect(() => putGoals(w.db, w.owner, "2026-11-02", { goals: [g("a")] }, MON_0930, cfg)).toThrowError(expect.objectContaining({ code: "past_week" }));
    expect(() => putGoals(w.db, w.owner, "2026-11-23", { goals: [g("a")] }, MON_0930, cfg)).toThrowError(expect.objectContaining({ code: "too_far_ahead" }));
  });

  it("owner and reviewer can both edit; the audit log names who", () => {
    const [a] = putGoals(w.db, w.owner, WEEK, { goals: [g("Launch")] }, MON_0930, cfg);
    putGoals(w.db, w.reviewer, WEEK, { goals: [{ id: a!.id, text: "Launch v2", measure: "m" }] }, MON_0930, cfg);
    const rows = audits().filter((r) => r.entity === "goal");
    expect(rows.map((r) => [r.action, r.actorId])).toEqual([
      ["goal.create", w.owner.id],
      ["goal.update", w.reviewer.id],
    ]);
    const upd = rows[1]!;
    expect(JSON.parse(upd.beforeJson!).text).toBe("Launch");
    expect(JSON.parse(upd.afterJson!).text).toBe("Launch v2");
  });

  it("unchanged goals produce no audit noise; anonymous is 401", () => {
    const [a] = putGoals(w.db, w.owner, WEEK, { goals: [g("Launch")] }, MON_0930, cfg);
    const n = audits().length;
    putGoals(w.db, w.owner, WEEK, { goals: [{ id: a!.id, ...g("Launch") }] }, MON_0930, cfg);
    expect(audits().length).toBe(n);
    expect(() => putGoals(w.db, null, WEEK, { goals: [] }, MON_0930, cfg)).toThrowError(expect.objectContaining({ status: 401 }));
  });

  it("a goal that outcomes point to cannot be removed", () => {
    const [a] = putGoals(w.db, w.owner, WEEK, { goals: [g("Launch")] }, MON_0930, cfg);
    addOutcome(w.db, w.owner, TODAY, input({ goalId: a!.id }), MON_0930, cfg);
    expect(() => putGoals(w.db, w.owner, WEEK, { goals: [] }, MON_0930, cfg)).toThrowError(expect.objectContaining({ status: 409, code: "goal_in_use" }));
    expect(w.db.select().from(goals).all()).toHaveLength(1);
  });
});

describe("audit trail", () => {
  it("records every mutation with actor, entity, before and after", () => {
    const [o] = plan(TODAY, 1);
    updateDraftOutcome(w.db, w.owner, o!.id, { level: 8 }, MON_0930);
    commitDay(w.db, w.owner, TODAY, MON_0930, cfg);
    closeOutcome(w.db, w.owner, o!.id, proof, MON_0930, cfg);
    logUnplanned(w.db, w.owner, TODAY, { title: "x", level: 1, result: "y", proofUrl: "https://a.b" }, MON_0930, cfg);
    closeDay(w.db, w.owner, TODAY, { highlight: "h" }, MON_0930, cfg);
    expect(actions()).toEqual([
      "day.create",
      "outcome.create",
      "outcome.update",
      "day.commit",
      "outcome.done",
      "outcome.unplanned",
      "day.close",
    ]);
    const done = audits().find((a) => a.action === "outcome.done")!;
    expect(done).toMatchObject({ actorId: w.owner.id, entity: "outcome", entityId: String(o!.id), at: MON_0930.toISOString() });
    expect(JSON.parse(done.beforeJson!).status).toBe("open");
    expect(JSON.parse(done.afterJson!).status).toBe("done");
    const commit = audits().find((a) => a.action === "day.commit")!;
    expect(JSON.parse(commit.beforeJson!).lockedAt).toBeNull();
    expect(JSON.parse(commit.afterJson!).lockedAt).toBe(MON_0930.toISOString());
  });

  it("failed operations leave no audit entry", () => {
    plan(TODAY, 3);
    const n = audits().length;
    expect(() => addOutcome(w.db, w.owner, TODAY, input(), MON_0930, cfg)).toThrow();
    expect(audits().length).toBe(n);
  });

  it("a carry writes the close and the new outcome", () => {
    const [o] = plan(TODAY, 1);
    commitDay(w.db, w.owner, TODAY, MON_0930, cfg);
    const before = audits().length;
    closeOutcome(w.db, w.owner, o!.id, { status: "carried", reason: "r" }, MON_0930, cfg);
    expect(audits().slice(before).map((a) => a.action)).toEqual(["outcome.carried", "day.create", "outcome.create"]);
  });
});

describe("My Day read model", () => {
  it("lists overdue open outcomes from earlier days and exposes the deadline", () => {
    plan(TODAY, 1);
    commitDay(w.db, w.owner, TODAY, MON_0930, cfg);
    const tuesday = new Date("2026-11-10T04:00:00Z");
    const v = getMyDay(w.db, undefined, tuesday, cfg);
    expect(v.date).toBe(TOMORROW);
    expect(v.overdue).toHaveLength(1);
    expect(v.deadlineAt).toBe("2026-11-10T05:30:00.000Z");
    expect(v.canCommit).toBe(true);
    expect(getMyDay(w.db, TODAY, MON_0930, cfg).canCommit).toBe(false); // already committed
  });

  it("canCommit turns false after the deadline", () => {
    plan(TODAY, 1);
    expect(getMyDay(w.db, TODAY, new Date("2026-11-09T05:30:00Z"), cfg).canCommit).toBe(false);
    expect(getMyDay(w.db, TODAY, new Date("2026-11-09T05:29:59Z"), cfg).canCommit).toBe(true);
  });

  it("reports unavailable (null) promises kept when nothing is committed", () => {
    expect(getMyDay(w.db, TODAY, MON_0930, cfg).summary.promisesKept).toBeNull();
  });
});
