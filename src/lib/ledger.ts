/**
 * Owner-side ledger rules. Every mutation is one transaction that also writes the audit entry.
 * Business rules live here (not in routes, not in the browser) so they can be tested directly.
 */
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "@/db";
import { dayNotes, days, goals, outcomes, reviews, type Day, type Goal, type Outcome } from "@/db/schema";
import { parseBody } from "@/lib/validate";
import { writeAudit } from "@/lib/audit";
import { requireRole, type Actor } from "@/lib/auth";
import { appTz, commitByHour } from "@/lib/env";
import { badRequest, conflict, invalid, notFound } from "@/lib/errors";
import {
  addOutcomeSchema,
  closeDaySchema,
  closeOutcomeSchema,
  goalsSchema,
  unplannedSchema,
  updateOutcomeSchema,
} from "@/lib/schemas";
import { computeReport, isDelivered, valueDelivered, type ScoredOutcome, type ScoredReview } from "@/lib/scoring";
import { addDays, isMonday, isValidDate, localDate, weekStartOf, zonedInstant } from "@/lib/time";

export const MAX_OUTCOMES_PER_DAY = 3;
export const MAX_GOALS_PER_WEEK = 3;
const UNPLANNED_POSITION_BASE = 10;

export interface Cfg {
  tz: string;
  commitByHour: number;
}
export const defaultCfg = (): Cfg => ({ tz: appTz(), commitByHour: commitByHour() });

// ---------- helpers ----------

export function assertDateParam(date: string): void {
  if (!isValidDate(date)) throw badRequest("Date must be YYYY-MM-DD");
}

/** Today or tomorrow in the app timezone — never the past. */
function assertPlannable(date: string, now: Date, cfg: Cfg): void {
  assertDateParam(date);
  const today = localDate(now, cfg.tz);
  if (date < today) throw invalid("past_day", "Plans cannot be made for a past day");
  if (date > addDays(today, 1)) throw invalid("too_far_ahead", "You can only plan today or tomorrow");
}

export function commitDeadline(date: string, cfg: Cfg): Date {
  return zonedInstant(date, cfg.commitByHour, cfg.tz);
}

const getDay = (tx: DbOrTx, date: string): Day | undefined => tx.select().from(days).where(eq(days.date, date)).get();

function ensureDay(tx: DbOrTx, date: string, now: Date, actor: Actor): Day {
  const existing = getDay(tx, date);
  if (existing) return existing;
  const row = tx.insert(days).values({ date }).returning().get();
  writeAudit(tx, { at: now, actorId: actor.id, action: "day.create", entity: "day", entityId: date, after: row });
  return row;
}

const plannedOf = (tx: DbOrTx, date: string): Outcome[] =>
  tx.select().from(outcomes).where(and(eq(outcomes.date, date), eq(outcomes.planned, true))).orderBy(asc(outcomes.position)).all();

function assertGoalForDate(tx: DbOrTx, goalId: number | null | undefined, date: string): void {
  if (goalId === null || goalId === undefined) return;
  const g = tx.select().from(goals).where(eq(goals.id, goalId)).get();
  if (!g) throw invalid("unknown_goal", "That weekly goal does not exist");
  if (g.weekStart !== weekStartOf(date)) throw invalid("goal_wrong_week", "That goal belongs to a different week");
}

const getOutcome = (tx: DbOrTx, id: number): Outcome => {
  const o = tx.select().from(outcomes).where(eq(outcomes.id, id)).get();
  if (!o) throw notFound("Outcome");
  return o;
};

// ---------- planning ----------

export function addOutcome(db: Db, actor: Actor | null, date: string, rawInput: unknown, now: Date, cfg = defaultCfg()): Outcome {
  const owner = requireRole(actor, "owner");
  assertPlannable(date, now, cfg);
  const input = parseBody(addOutcomeSchema, rawInput);
  return db.transaction((tx) => {
    const day = ensureDay(tx, date, now, owner);
    if (day.lockedAt) throw conflict("day_locked", "This day is committed; its plan can no longer change");
    const existing = plannedOf(tx, date);
    if (existing.length >= MAX_OUTCOMES_PER_DAY) {
      throw invalid("outcome_limit", `A day can hold at most ${MAX_OUTCOMES_PER_DAY} committed outcomes`);
    }
    assertGoalForDate(tx, input.goalId, date);
    const position = existing.reduce((m, o) => Math.max(m, o.position), 0) + 1;
    const row = tx
      .insert(outcomes)
      .values({
        date,
        position,
        title: input.title,
        doneMeans: input.doneMeans,
        level: input.level,
        goalId: input.goalId ?? null,
        planned: true,
        status: "open",
        createdAt: now.toISOString(),
      })
      .returning()
      .get();
    writeAudit(tx, { at: now, actorId: owner.id, action: "outcome.create", entity: "outcome", entityId: row.id, after: row });
    return row;
  });
}

export function updateDraftOutcome(db: Db, actor: Actor | null, id: number, rawInput: unknown, now: Date): Outcome {
  const owner = requireRole(actor, "owner");
  const input = parseBody(updateOutcomeSchema, rawInput);
  return db.transaction((tx) => {
    const before = getOutcome(tx, id);
    const day = getDay(tx, before.date);
    if (!before.planned || day?.lockedAt) {
      throw conflict("outcome_locked", "Committed outcomes cannot be edited");
    }
    if (input.goalId !== undefined) assertGoalForDate(tx, input.goalId, before.date);
    const patch: Partial<typeof outcomes.$inferInsert> = {};
    if (input.title !== undefined) patch.title = input.title;
    if (input.doneMeans !== undefined) patch.doneMeans = input.doneMeans;
    if (input.level !== undefined) patch.level = input.level;
    if (input.goalId !== undefined) patch.goalId = input.goalId;
    const after = tx.update(outcomes).set(patch).where(eq(outcomes.id, id)).returning().get();
    writeAudit(tx, { at: now, actorId: owner.id, action: "outcome.update", entity: "outcome", entityId: id, before, after });
    return after;
  });
}

export function deleteDraftOutcome(db: Db, actor: Actor | null, id: number, now: Date): void {
  const owner = requireRole(actor, "owner");
  db.transaction((tx) => {
    const before = getOutcome(tx, id);
    const day = getDay(tx, before.date);
    if (!before.planned || day?.lockedAt) {
      throw conflict("outcome_locked", "Committed outcomes cannot be deleted");
    }
    tx.delete(outcomes).where(eq(outcomes.id, id)).run();
    writeAudit(tx, { at: now, actorId: owner.id, action: "outcome.delete", entity: "outcome", entityId: id, before });
  });
}

export function commitDay(db: Db, actor: Actor | null, date: string, now: Date, cfg = defaultCfg()): Day {
  const owner = requireRole(actor, "owner");
  assertPlannable(date, now, cfg);
  return db.transaction((tx) => {
    const before = getDay(tx, date);
    if (before?.lockedAt) throw conflict("already_committed", "This day is already committed");
    const planned = plannedOf(tx, date);
    if (planned.length < 1) throw invalid("empty_plan", "Add at least one outcome before committing");
    if (planned.length > MAX_OUTCOMES_PER_DAY) throw invalid("outcome_limit", "Too many outcomes");
    // Server time only. Deadline is exclusive: 10:59:59.999 is on time, 11:00:00.000 is late.
    if (now.getTime() >= commitDeadline(date, cfg).getTime()) {
      throw conflict(
        "deadline_passed",
        `The ${String(cfg.commitByHour).padStart(2, "0")}:00 commit deadline has passed. Late commits are not allowed.`,
      );
    }
    const day = ensureDay(tx, date, now, owner);
    const after = tx.update(days).set({ lockedAt: now.toISOString() }).where(eq(days.date, date)).returning().get();
    writeAudit(tx, { at: now, actorId: owner.id, action: "day.commit", entity: "day", entityId: date, before: before ?? day, after });
    return after;
  });
}

// ---------- closing outcomes ----------

export interface CloseResult {
  outcome: Outcome;
  /** The fresh open outcome created for tomorrow, or null (not carried forward). */
  carriedTo: Outcome | null;
  carryNote: string | null;
}

export function closeOutcome(db: Db, actor: Actor | null, id: number, rawInput: unknown, now: Date, cfg = defaultCfg()): CloseResult {
  const owner = requireRole(actor, "owner");
  const input = parseBody(closeOutcomeSchema, rawInput);
  return db.transaction((tx) => {
    const before = getOutcome(tx, id);
    const day = getDay(tx, before.date);
    if (!before.planned) throw conflict("outcome_not_open", "Unplanned work is logged already closed");
    if (!day?.lockedAt) throw conflict("day_not_committed", "Commit the plan before closing its outcomes");
    if (before.status !== "open") throw conflict("outcome_not_open", "This outcome is already closed");
    const today = localDate(now, cfg.tz);
    if (before.date > today) throw invalid("future_day", "An outcome can only be closed on or after its day");

    const closedAt = now.toISOString();
    let patch: Partial<typeof outcomes.$inferInsert>;
    if (input.status === "done") {
      patch = { status: "done", proofUrl: input.proofUrl, result: input.result, closedAt };
    } else {
      patch = { status: input.status, reason: input.reason, closedAt };
    }
    const after = tx.update(outcomes).set(patch).where(eq(outcomes.id, id)).returning().get();
    writeAudit(tx, { at: now, actorId: owner.id, action: `outcome.${input.status}`, entity: "outcome", entityId: id, before, after });

    let carriedTo: Outcome | null = null;
    let carryNote: string | null = null;
    if (input.status === "carried") {
      const target = addDays(today, 1);
      const targetDay = getDay(tx, target);
      const targetPlanned = plannedOf(tx, target);
      if (targetDay?.lockedAt) {
        carryNote = "Tomorrow's plan is already committed, so nothing was added. It scores zero today.";
      } else if (targetPlanned.length >= MAX_OUTCOMES_PER_DAY) {
        carryNote = "Tomorrow is full, so nothing was added. It scores zero today.";
      } else {
        ensureDay(tx, target, now, owner);
        carriedTo = tx
          .insert(outcomes)
          .values({
            date: target,
            position: targetPlanned.reduce((m, o) => Math.max(m, o.position), 0) + 1,
            title: before.title,
            doneMeans: before.doneMeans,
            level: before.level,
            goalId: before.goalId,
            planned: true,
            status: "open",
            carriedFrom: before.id,
            createdAt: closedAt,
          })
          .returning()
          .get();
        writeAudit(tx, { at: now, actorId: owner.id, action: "outcome.create", entity: "outcome", entityId: carriedTo.id, after: carriedTo });
      }
    }
    return { outcome: after, carriedTo, carryNote };
  });
}

// ---------- unplanned work ----------

export function logUnplanned(db: Db, actor: Actor | null, date: string, rawInput: unknown, now: Date, cfg = defaultCfg()): Outcome {
  const owner = requireRole(actor, "owner");
  assertDateParam(date);
  const today = localDate(now, cfg.tz);
  if (date < today) throw invalid("past_day", "Unplanned work can only be logged for today");
  if (date > today) throw invalid("future_day", "Unplanned work can only be logged for today");
  const input = parseBody(unplannedSchema, rawInput);
  return db.transaction((tx) => {
    const day = ensureDay(tx, date, now, owner);
    if (day.closedAt) throw conflict("day_closed", "This day is closed");
    assertGoalForDate(tx, input.goalId, date);
    const maxPos = tx
      .select({ m: sql<number>`coalesce(max(${outcomes.position}), 0)` })
      .from(outcomes)
      .where(and(eq(outcomes.date, date), eq(outcomes.planned, false)))
      .get();
    const row = tx
      .insert(outcomes)
      .values({
        date,
        position: Math.max(UNPLANNED_POSITION_BASE, (maxPos?.m ?? 0) + 1),
        title: input.title,
        doneMeans: "",
        level: input.level,
        goalId: input.goalId ?? null,
        planned: false,
        status: "done",
        proofUrl: input.proofUrl,
        result: input.result,
        createdAt: now.toISOString(),
        closedAt: now.toISOString(),
      })
      .returning()
      .get();
    writeAudit(tx, { at: now, actorId: owner.id, action: "outcome.unplanned", entity: "outcome", entityId: row.id, after: row });
    return row;
  });
}

// ---------- close the day ----------

export function closeDay(db: Db, actor: Actor | null, date: string, rawInput: unknown, now: Date, cfg = defaultCfg()): Day {
  const owner = requireRole(actor, "owner");
  assertDateParam(date);
  if (date > localDate(now, cfg.tz)) throw invalid("future_day", "A future day cannot be closed");
  const input = parseBody(closeDaySchema, rawInput);
  return db.transaction((tx) => {
    const before = ensureDay(tx, date, now, owner);
    if (before.closedAt) throw conflict("day_closed", "This day is already closed");
    const all = tx.select().from(outcomes).where(eq(outcomes.date, date)).all();
    if (!before.lockedAt && all.some((o) => o.planned)) {
      throw conflict("uncommitted_plan", "Commit or delete the draft plan before closing the day");
    }
    if (all.some((o) => o.status === "open")) {
      throw conflict("open_outcomes", "Close every committed outcome (done, missed or carried) first");
    }
    const after = tx
      .update(days)
      .set({ closedAt: now.toISOString(), highlight: input.highlight, learning: input.learning })
      .where(eq(days.date, date))
      .returning()
      .get();
    writeAudit(tx, { at: now, actorId: owner.id, action: "day.close", entity: "day", entityId: date, before, after });
    return after;
  });
}

// ---------- weekly goals ----------

export function getGoals(db: Db, weekStart: string): Goal[] {
  if (!isMonday(weekStart)) throw badRequest("weekStart must be a Monday in YYYY-MM-DD");
  return db.select().from(goals).where(eq(goals.weekStart, weekStart)).orderBy(asc(goals.id)).all();
}

/** Owner and reviewers may both edit goals (spec assumption). Replaces the week's goal list. */
export function putGoals(db: Db, actor: Actor | null, weekStart: string, rawInput: unknown, now: Date, cfg = defaultCfg()): Goal[] {
  const who = requireRole(actor, "owner", "reviewer");
  if (!isMonday(weekStart)) throw badRequest("weekStart must be a Monday in YYYY-MM-DD");
  const thisWeek = weekStartOf(localDate(now, cfg.tz));
  if (weekStart < thisWeek) throw invalid("past_week", "Goals for a past week cannot be changed");
  if (weekStart > addDays(thisWeek, 7)) throw invalid("too_far_ahead", "Goals can be set for this week or next week");
  const input = parseBody(goalsSchema, rawInput);
  return db.transaction((tx) => {
    const existing = tx.select().from(goals).where(eq(goals.weekStart, weekStart)).orderBy(asc(goals.id)).all();
    const byId = new Map(existing.map((g) => [g.id, g]));
    const keep = new Set<number>();
    for (const g of input.goals) {
      if (g.id !== undefined) {
        if (!byId.has(g.id)) throw invalid("unknown_goal", "Goal does not belong to this week");
        if (keep.has(g.id)) throw invalid("duplicate_goal", "Duplicate goal id");
        keep.add(g.id);
      }
    }
    for (const g of existing) {
      if (keep.has(g.id)) continue;
      const used = tx.select({ id: outcomes.id }).from(outcomes).where(eq(outcomes.goalId, g.id)).limit(1).get();
      if (used) throw conflict("goal_in_use", "A goal that outcomes point to cannot be removed");
      tx.delete(goals).where(eq(goals.id, g.id)).run();
      writeAudit(tx, { at: now, actorId: who.id, action: "goal.delete", entity: "goal", entityId: g.id, before: g });
    }
    for (const g of input.goals) {
      if (g.id !== undefined) {
        const before = byId.get(g.id)!;
        if (before.text === g.text && before.measure === g.measure) continue;
        const after = tx
          .update(goals)
          .set({ text: g.text, measure: g.measure, updatedAt: now.toISOString() })
          .where(eq(goals.id, g.id))
          .returning()
          .get();
        writeAudit(tx, { at: now, actorId: who.id, action: "goal.update", entity: "goal", entityId: g.id, before, after });
      } else {
        const after = tx
          .insert(goals)
          .values({ weekStart, text: g.text, measure: g.measure, createdAt: now.toISOString(), updatedAt: now.toISOString() })
          .returning()
          .get();
        writeAudit(tx, { at: now, actorId: who.id, action: "goal.create", entity: "goal", entityId: after.id, after });
      }
    }
    return tx.select().from(goals).where(eq(goals.weekStart, weekStart)).orderBy(asc(goals.id)).all();
  });
}

// ---------- My Day read model ----------

const toScored = (o: Outcome): ScoredOutcome => ({
  id: o.id,
  level: o.level,
  planned: o.planned,
  status: o.status,
  proofUrl: o.proofUrl,
  result: o.result,
  goalId: o.goalId,
});

export function reviewsFor(db: DbOrTx, ids: number[]): ScoredReview[] {
  if (!ids.length) return [];
  return db
    .select({ outcomeId: reviews.outcomeId, confirmedPoints: reviews.confirmedPoints, updatedAt: reviews.updatedAt })
    .from(reviews)
    .where(inArray(reviews.outcomeId, ids))
    .all();
}

export interface MyDayView {
  today: string;
  tomorrow: string;
  date: string;
  weekStart: string;
  commitByHour: number;
  tz: string;
  deadlineAt: string;
  /** False once the deadline has passed (today) or the day is committed/past. */
  canCommit: boolean;
  day: { date: string; lockedAt: string | null; closedAt: string | null; highlight: string | null; learning: string | null };
  planned: Outcome[];
  unplanned: Outcome[];
  /** Open committed outcomes from earlier days that still need closing. */
  overdue: Outcome[];
  goals: Goal[];
  reviewerNotes: { note: string; updatedAt: string }[];
  /** Per-outcome review state, keyed by outcome id: confirmed points or null (awaiting). */
  confirmedPoints: Record<number, number>;
  summary: {
    promisedPoints: number;
    deliveredPoints: { confirmed: number; awaiting: number; total: number };
    promisesKept: number | null; // percent, null = unavailable
    unplannedPoints: number;
    allResolved: boolean;
  };
}

export function getMyDay(db: Db, dateParam: string | undefined, now: Date, cfg = defaultCfg()): MyDayView {
  const today = localDate(now, cfg.tz);
  const tomorrow = addDays(today, 1);
  const date = dateParam ?? today;
  assertDateParam(date);
  if (date < today || date > tomorrow) {
    // Past days are read-only history in Phase 2; My Day shows today or tomorrow.
    throw invalid("out_of_range", "My Day shows today or tomorrow");
  }
  const day = getDay(db, date) ?? { date, lockedAt: null, closedAt: null, highlight: null, learning: null };
  const rows = db.select().from(outcomes).where(eq(outcomes.date, date)).orderBy(asc(outcomes.position)).all();
  const planned = rows.filter((o) => o.planned);
  const unplanned = rows.filter((o) => !o.planned);
  const overdue = db
    .select({ o: outcomes })
    .from(outcomes)
    .innerJoin(days, eq(days.date, outcomes.date))
    .where(and(lt(outcomes.date, today), eq(outcomes.status, "open"), eq(outcomes.planned, true), sql`${days.lockedAt} is not null`))
    .orderBy(asc(outcomes.date), asc(outcomes.position))
    .all()
    .map((r) => r.o);
  const ids = rows.map((o) => o.id);
  const revs = reviewsFor(db, ids);
  const notes = db.select().from(dayNotes).where(eq(dayNotes.date, date)).orderBy(desc(dayNotes.updatedAt)).all();
  const scored = rows.map(toScored);
  const report = computeReport({
    outcomes: day.lockedAt ? scored : scored.filter((o) => !o.planned),
    reviews: revs,
    days: [],
  });
  const confirmedPoints: Record<number, number> = {};
  const latest = new Map<number, ScoredReview>();
  for (const r of revs) {
    const p = latest.get(r.outcomeId);
    if (!p || r.updatedAt >= p.updatedAt) latest.set(r.outcomeId, r);
  }
  for (const [id, r] of latest) confirmedPoints[id] = r.confirmedPoints;
  const committed = day.lockedAt ? planned : [];
  const dv = valueDelivered(
    scored.filter((o) => !o.planned || day.lockedAt),
    revs,
  );
  return {
    today,
    tomorrow,
    date,
    weekStart: weekStartOf(date),
    commitByHour: cfg.commitByHour,
    tz: cfg.tz,
    deadlineAt: commitDeadline(date, cfg).toISOString(),
    canCommit: !day.lockedAt && now.getTime() < commitDeadline(date, cfg).getTime(),
    day,
    planned,
    unplanned,
    overdue,
    goals: db.select().from(goals).where(eq(goals.weekStart, weekStartOf(date))).orderBy(asc(goals.id)).all(),
    reviewerNotes: notes.map((n) => ({ note: n.note, updatedAt: n.updatedAt })),
    confirmedPoints,
    summary: {
      promisedPoints: committed.reduce((s, o) => s + o.level, 0),
      deliveredPoints: dv,
      promisesKept: report.promisesKept.value === null ? null : Math.round(report.promisesKept.value * 100),
      unplannedPoints: unplanned.filter(isDelivered).reduce((s, o) => s + o.level, 0),
      allResolved: committed.every((o) => o.status !== "open"),
    },
  };
}

