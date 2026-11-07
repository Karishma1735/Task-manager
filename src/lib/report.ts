/**
 * Report read model. Every number comes from lib/scoring.ts — nothing here counts tasks.
 */
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import type { Db } from "@/db";
import { dayNotes, days, goals, outcomes, reviews, users, type Outcome } from "@/db/schema";
import { defaultCfg, assertDateParam, commitDeadline, type Cfg } from "@/lib/ledger";
import { badRequest, invalid } from "@/lib/errors";
import {
  computeReport,
  effectivePoints,
  isDelivered,
  isValidProofUrl,
  latestReviews,
  toPercent,
  valueByLevel,
  valueDelivered,
  type DayFacts,
  type Measure,
  type PointsState,
  type ScoredOutcome,
  type ScoredReview,
  type ValueByLevel,
} from "@/lib/scoring";
import { addDays, isMonday, localDate, weekDates, weekStartOf } from "@/lib/time";

export type WeekStatus = "nothing" | "awaiting" | "partly" | "reviewed";

export interface MeasureView {
  /** Whole-number percent, or null when unavailable (zero denominator). */
  percent: number | null;
  formula: string;
}

export interface CircleView {
  id: number;
  date: string;
  title: string;
  claimed: number;
  points: number;
  state: Exclude<PointsState, "none">;
  planned: boolean;
}

export interface DayOutcomeView {
  id: number;
  title: string;
  doneMeans: string;
  planned: boolean;
  level: number;
  status: Outcome["status"];
  result: string | null;
  reason: string | null;
  proofUrl: string | null;
  goalId: number | null;
  delivered: boolean;
  /** Effective points (0 unless delivered). */
  points: number;
  state: PointsState;
  /** The current reviewer-confirmed points, if reviewed. */
  confirmedPoints: number | null;
}

export interface DayView {
  date: string;
  lockedAt: string | null;
  closedAt: string | null;
  highlight: string | null;
  learning: string | null;
  promisedPoints: number;
  /** Claimed points of delivered promised outcomes (the promises-kept numerator). */
  keptPoints: number;
  delivered: { confirmed: number; awaiting: number; total: number };
  outcomes: DayOutcomeView[];
  notes: { reviewer: string; note: string; updatedAt: string }[];
}

export interface WeekBar {
  weekStart: string;
  byLevel: ValueByLevel;
  confirmed: number;
  awaiting: number;
  total: number;
}

export interface GoalProgress {
  id: number;
  text: string;
  measure: string;
  confirmed: number;
  awaiting: number;
  total: number;
  /** Share of the week's value, whole percent; null when nothing was delivered. */
  sharePercent: number | null;
}

export interface ReportView {
  ownerName: string;
  weekStart: string;
  weekEnd: string;
  prevWeek: string;
  nextWeek: string | null;
  isCurrentWeek: boolean;
  status: WeekStatus;
  value: { confirmed: number; awaiting: number; total: number };
  measures: {
    promisesKept: MeasureView;
    highLeverageShare: MeasureView;
    onGoal: MeasureView;
    claimAccuracy: MeasureView;
    unplannedShare: MeasureView;
    rhythm: MeasureView;
  };
  circles: CircleView[];
  eightWeeks: WeekBar[];
  goals: GoalProgress[];
  /** Newest first. */
  days: DayView[];
}

export const FORMULAS = {
  promisesKept: "Claimed points of delivered commitments ÷ claimed points of all commitments",
  highLeverageShare: "Effective points from outcomes worth 4 or 8 ÷ value delivered",
  onGoal: "Effective points tied to a weekly goal ÷ value delivered",
  claimAccuracy: "Confirmed points ÷ claimed points, over reviewed outcomes only",
  unplannedShare: "Effective points of unplanned outcomes ÷ value delivered",
  rhythm: "(Days committed by the deadline + days closed the same day) ÷ (2 × days committed)",
} as const;

const toScored = (o: Outcome): ScoredOutcome => ({
  id: o.id,
  level: o.level,
  planned: o.planned,
  status: o.status,
  proofUrl: o.proofUrl,
  result: o.result,
  goalId: o.goalId,
});

const mv = (m: Measure, formula: string): MeasureView => ({ percent: toPercent(m), formula });

export function resolveWeek(weekParam: string | undefined, now: Date, cfg: Cfg): string {
  const current = weekStartOf(localDate(now, cfg.tz));
  if (!weekParam) return current;
  assertDateParam(weekParam);
  if (!isMonday(weekParam)) throw badRequest("week must be a Monday in YYYY-MM-DD");
  if (weekParam > current) throw invalid("future_week", "That week has not started yet");
  return weekParam;
}

export function getReport(db: Db, weekParam: string | undefined, now: Date, cfg = defaultCfg()): ReportView {
  const weekStart = resolveWeek(weekParam, now, cfg);
  const currentWeek = weekStartOf(localDate(now, cfg.tz));
  const weekEnd = addDays(weekStart, 6);
  const rangeStart = addDays(weekStart, -49); // seven earlier weeks + this one

  const dayRows = db.select().from(days).where(and(gte(days.date, rangeStart), lte(days.date, weekEnd))).all();
  const dayByDate = new Map(dayRows.map((d) => [d.date, d]));
  const outcomeRows = db
    .select()
    .from(outcomes)
    .where(and(gte(outcomes.date, rangeStart), lte(outcomes.date, weekEnd)))
    .orderBy(asc(outcomes.date), asc(outcomes.position))
    .all()
    // Drafts (planned outcomes of an uncommitted day) are not part of the ledger.
    .filter((o) => !o.planned || Boolean(dayByDate.get(o.date)?.lockedAt));
  const reviewRows: ScoredReview[] = outcomeRows.length
    ? db
        .select({ outcomeId: reviews.outcomeId, confirmedPoints: reviews.confirmedPoints, updatedAt: reviews.updatedAt })
        .from(reviews)
        .where(inArray(reviews.outcomeId, outcomeRows.map((o) => o.id)))
        .all()
    : [];
  const latest = latestReviews(reviewRows);

  // ----- this week
  const weekDays = new Set(weekDates(weekStart));
  const weekOutcomes = outcomeRows.filter((o) => weekDays.has(o.date));
  const weekScored = weekOutcomes.map(toScored);
  const facts: DayFacts[] = dayRows
    .filter((d) => weekDays.has(d.date) && d.lockedAt)
    .map((d) => ({
      committed: true,
      committedOnTime: new Date(d.lockedAt!).getTime() < commitDeadline(d.date, cfg).getTime(),
      closedSameDay: d.closedAt ? localDate(new Date(d.closedAt), cfg.tz) === d.date : false,
    }));
  const rep = computeReport({ outcomes: weekScored, reviews: reviewRows, days: facts });

  const circles: CircleView[] = [];
  for (const o of weekOutcomes) {
    const e = effectivePoints(toScored(o), latest);
    if (e.state === "none") continue;
    circles.push({ id: o.id, date: o.date, title: o.title, claimed: o.level, points: e.points, state: e.state, planned: o.planned });
  }

  const deliveredOnes = weekScored.filter(isDelivered);
  const reviewedCount = deliveredOnes.filter((o) => latest.has(o.id)).length;
  const status: WeekStatus =
    deliveredOnes.length === 0 ? "nothing" : reviewedCount === 0 ? "awaiting" : reviewedCount === deliveredOnes.length ? "reviewed" : "partly";

  // ----- eight weeks
  const eightWeeks: WeekBar[] = [];
  for (let i = 7; i >= 0; i--) {
    const ws = addDays(weekStart, -7 * i);
    const dates = new Set(weekDates(ws));
    const scoped = outcomeRows.filter((o) => dates.has(o.date)).map(toScored);
    const byLevel = valueByLevel(scoped, reviewRows);
    const v = valueDelivered(scoped, reviewRows);
    eightWeeks.push({ weekStart: ws, byLevel, confirmed: v.confirmed, awaiting: v.awaiting, total: v.total });
  }

  // ----- goals
  const goalRows = db.select().from(goals).where(eq(goals.weekStart, weekStart)).orderBy(asc(goals.id)).all();
  const goalProgress: GoalProgress[] = goalRows.map((g) => {
    const tied = weekScored.filter((o) => o.goalId === g.id);
    const v = valueDelivered(tied, reviewRows);
    return {
      id: g.id,
      text: g.text,
      measure: g.measure,
      ...v,
      sharePercent: rep.value.total > 0 ? Math.round((v.total / rep.value.total) * 100) : null,
    };
  });

  // ----- day by day
  const noteRows = db.select().from(dayNotes).where(and(gte(dayNotes.date, weekStart), lte(dayNotes.date, weekEnd))).all();
  const reviewerNames = new Map(db.select({ id: users.id, name: users.name }).from(users).all().map((u) => [u.id, u.name]));
  const dayViews: DayView[] = [];
  for (const date of weekDates(weekStart).reverse()) {
    const d = dayByDate.get(date);
    const todays = outcomeRows.filter((o) => o.date === date);
    if (!d || (todays.length === 0 && !d.closedAt)) continue;
    const planned = todays.filter((o) => o.planned).map(toScored);
    const scored = todays.map(toScored);
    dayViews.push({
      date,
      lockedAt: d.lockedAt,
      closedAt: d.closedAt,
      highlight: d.highlight,
      learning: d.learning,
      promisedPoints: planned.reduce((s, o) => s + o.level, 0),
      keptPoints: planned.filter(isDelivered).reduce((s, o) => s + o.level, 0),
      delivered: valueDelivered(scored, reviewRows),
      outcomes: todays.map((o) => {
        const e = effectivePoints(toScored(o), latest);
        return {
          id: o.id,
          title: o.title,
          doneMeans: o.doneMeans,
          planned: o.planned,
          level: o.level,
          status: o.status,
          result: o.result,
          reason: o.reason,
          proofUrl: isValidProofUrl(o.proofUrl) ? o.proofUrl!.trim() : null,
          goalId: o.goalId,
          delivered: e.state !== "none",
          points: e.points,
          state: e.state,
          confirmedPoints: latest.get(o.id)?.confirmedPoints ?? null,
        };
      }),
      notes: noteRows
        .filter((n) => n.date === date)
        .map((n) => ({ reviewer: reviewerNames.get(n.reviewerId) ?? "Reviewer", note: n.note, updatedAt: n.updatedAt })),
    });
  }

  const owner = db.select({ name: users.name }).from(users).where(eq(users.role, "owner")).limit(1).get();
  return {
    ownerName: owner?.name ?? "Owner",
    weekStart,
    weekEnd,
    prevWeek: addDays(weekStart, -7),
    nextWeek: weekStart < currentWeek ? addDays(weekStart, 7) : null,
    isCurrentWeek: weekStart === currentWeek,
    status,
    value: rep.value,
    measures: {
      promisesKept: mv(rep.promisesKept, FORMULAS.promisesKept),
      highLeverageShare: mv(rep.highLeverageShare, FORMULAS.highLeverageShare),
      onGoal: mv(rep.onGoal, FORMULAS.onGoal),
      claimAccuracy: mv(rep.claimAccuracy, FORMULAS.claimAccuracy),
      unplannedShare: mv(rep.unplannedShare, FORMULAS.unplannedShare),
      rhythm: mv(rep.rhythm, FORMULAS.rhythm),
    },
    circles,
    eightWeeks,
    goals: goalProgress,
    days: dayViews,
  };
}
