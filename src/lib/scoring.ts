/**
 * Value Ledger scoring engine — PURE. No I/O, no clock, no database.
 * Every number shown on a report is computed here so it can be audited.
 *
 * Rules (docs/SPEC.md):
 *  - A *delivered* outcome has status "done", a valid http(s) proof URL and a non-empty result note.
 *  - Effective points = the latest reviewer-confirmed points if reviewed, otherwise the claimed level
 *    (reported as "awaiting review"). Claimed points are never treated as confirmed.
 *  - Missed, carried and open outcomes earn zero. Task count is never used.
 *  - A measure whose denominator is zero is `null` (unavailable) — never NaN, never a misleading 100%.
 */

export const LEVELS = [1, 2, 4, 8] as const;
export type Level = (typeof LEVELS)[number];
export const CONFIRMED_POINTS = [0, 1, 2, 4, 8] as const;
export type ConfirmedPoints = (typeof CONFIRMED_POINTS)[number];

export const LEVEL_NAMES: Record<Level, string> = { 1: "Upkeep", 2: "Progress", 4: "Shipped", 8: "Multiplier" };
export const LEVEL_HINTS: Record<Level, string> = {
  1: "Keeps things running: replies, routine fixes, meetings",
  2: "A real step toward a goal that nobody can use yet",
  4: "Something other people can use today",
  8: "Keeps paying back: saves hours every week, unblocks a team or wins a customer",
};

export type OutcomeStatus = "open" | "done" | "missed" | "carried";

export interface ScoredOutcome {
  id: number;
  level: number; // claimed points
  planned: boolean;
  status: OutcomeStatus;
  proofUrl: string | null;
  result: string | null;
  goalId: number | null;
}

export interface ScoredReview {
  outcomeId: number;
  confirmedPoints: number;
  updatedAt: string; // ISO timestamp; latest wins
}

export function isValidLevel(n: unknown): n is Level {
  return typeof n === "number" && (LEVELS as readonly number[]).includes(n);
}

export function isValidConfirmedPoints(n: unknown): n is ConfirmedPoints {
  return typeof n === "number" && (CONFIRMED_POINTS as readonly number[]).includes(n);
}

export function isValidProofUrl(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const t = s.trim();
  if (t.length === 0 || t.length > 2048 || /\s/.test(t)) return false;
  try {
    const u = new URL(t);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname.length > 0;
  } catch {
    return false;
  }
}

export function isDelivered(o: Pick<ScoredOutcome, "status" | "proofUrl" | "result">): boolean {
  return o.status === "done" && isValidProofUrl(o.proofUrl) && typeof o.result === "string" && o.result.trim().length > 0;
}

/** Latest review wins (by updatedAt, ties broken by input order — later entry wins). */
export function latestReviews(reviews: readonly ScoredReview[]): Map<number, ScoredReview> {
  const latest = new Map<number, ScoredReview>();
  for (const r of reviews) {
    if (!isValidConfirmedPoints(r.confirmedPoints)) continue; // ignore corrupt rows rather than count them
    const prev = latest.get(r.outcomeId);
    if (!prev || r.updatedAt >= prev.updatedAt) latest.set(r.outcomeId, r);
  }
  return latest;
}

export type PointsState = "confirmed" | "awaiting" | "none";
export interface EffectivePoints {
  points: number;
  state: PointsState;
  claimed: number;
}

export function effectivePoints(o: ScoredOutcome, reviews: ReadonlyMap<number, ScoredReview>): EffectivePoints {
  if (!isDelivered(o)) return { points: 0, state: "none", claimed: 0 };
  const rv = reviews.get(o.id);
  if (rv) return { points: rv.confirmedPoints, state: "confirmed", claimed: o.level };
  return { points: o.level, state: "awaiting", claimed: o.level };
}

export interface ValueDelivered {
  confirmed: number;
  awaiting: number;
  total: number;
}

/** "N confirmed plus M awaiting review". */
export function valueDelivered(outcomes: readonly ScoredOutcome[], reviews: readonly ScoredReview[]): ValueDelivered {
  const latest = latestReviews(reviews);
  let confirmed = 0;
  let awaiting = 0;
  for (const o of outcomes) {
    const e = effectivePoints(o, latest);
    if (e.state === "confirmed") confirmed += e.points;
    else if (e.state === "awaiting") awaiting += e.points;
  }
  return { confirmed, awaiting, total: confirmed + awaiting };
}

export interface Measure {
  /** Ratio in [0, ∞); null when unavailable (zero denominator). */
  value: number | null;
  numerator: number;
  denominator: number;
}

function ratio(numerator: number, denominator: number): Measure {
  return { value: denominator > 0 ? numerator / denominator : null, numerator, denominator };
}

/** Claimed points of delivered committed outcomes ÷ claimed points of all committed outcomes. */
export function promisesKept(committed: readonly ScoredOutcome[]): Measure {
  let kept = 0;
  let all = 0;
  for (const o of committed) {
    if (!o.planned) continue; // unplanned work can never inflate promises kept
    all += o.level;
    if (isDelivered(o)) kept += o.level;
  }
  return ratio(kept, all);
}

/** Effective points from outcomes worth 4 or 8 ÷ value delivered. */
export function highLeverageShare(outcomes: readonly ScoredOutcome[], reviews: readonly ScoredReview[]): Measure {
  const latest = latestReviews(reviews);
  let high = 0;
  let total = 0;
  for (const o of outcomes) {
    const e = effectivePoints(o, latest);
    total += e.points;
    if (e.points >= 4) high += e.points;
  }
  return ratio(high, total);
}

/** Effective points tied to a weekly goal ÷ value delivered. */
export function onGoal(outcomes: readonly ScoredOutcome[], reviews: readonly ScoredReview[]): Measure {
  const latest = latestReviews(reviews);
  let tied = 0;
  let total = 0;
  for (const o of outcomes) {
    const e = effectivePoints(o, latest);
    total += e.points;
    if (o.goalId !== null) tied += e.points;
  }
  return ratio(tied, total);
}

/** Confirmed points ÷ claimed points, over reviewed delivered outcomes only. Above 100% if the reviewer raises a score. */
export function claimAccuracy(outcomes: readonly ScoredOutcome[], reviews: readonly ScoredReview[]): Measure {
  const latest = latestReviews(reviews);
  let confirmed = 0;
  let claimed = 0;
  for (const o of outcomes) {
    const e = effectivePoints(o, latest);
    if (e.state !== "confirmed") continue;
    confirmed += e.points;
    claimed += e.claimed;
  }
  return ratio(confirmed, claimed);
}

/** Effective points of unplanned outcomes ÷ value delivered. */
export function unplannedShare(outcomes: readonly ScoredOutcome[], reviews: readonly ScoredReview[]): Measure {
  const latest = latestReviews(reviews);
  let unplanned = 0;
  let total = 0;
  for (const o of outcomes) {
    const e = effectivePoints(o, latest);
    total += e.points;
    if (!o.planned) unplanned += e.points;
  }
  return ratio(unplanned, total);
}

export interface DayFacts {
  /** The plan was committed (locked_at set). */
  committed: boolean;
  /** The lock happened before the commit deadline for that date. */
  committedOnTime: boolean;
  /** The day was closed on the same calendar date (app timezone). */
  closedSameDay: boolean;
}

/**
 * Rhythm = (days committed by the deadline + days closed the same day) ÷ (2 × days committed).
 * The spec states "days committed by 11:00 ÷ days committed, plus days closed the same day"; this is the
 * reading that keeps the measure in 0..100% — each half of the habit carries equal weight.
 */
export function rhythm(days: readonly DayFacts[]): Measure {
  const committed = days.filter((d) => d.committed);
  const onTime = committed.filter((d) => d.committedOnTime).length;
  const sameDay = committed.filter((d) => d.closedSameDay).length;
  return ratio(onTime + sameDay, 2 * committed.length);
}

export interface ReportMeasures {
  value: ValueDelivered;
  promisesKept: Measure;
  highLeverageShare: Measure;
  onGoal: Measure;
  claimAccuracy: Measure;
  unplannedShare: Measure;
  rhythm: Measure;
}

export interface ReportInput {
  /** Every outcome in scope (planned committed + unplanned). Draft (uncommitted) outcomes must be excluded by the caller. */
  outcomes: readonly ScoredOutcome[];
  reviews: readonly ScoredReview[];
  days: readonly DayFacts[];
}

export function computeReport(input: ReportInput): ReportMeasures {
  const committed = input.outcomes.filter((o) => o.planned);
  return {
    value: valueDelivered(input.outcomes, input.reviews),
    promisesKept: promisesKept(committed),
    highLeverageShare: highLeverageShare(input.outcomes, input.reviews),
    onGoal: onGoal(input.outcomes, input.reviews),
    claimAccuracy: claimAccuracy(input.outcomes, input.reviews),
    unplannedShare: unplannedShare(input.outcomes, input.reviews),
    rhythm: rhythm(input.days),
  };
}

/** Whole-number percentage for display; null stays null. */
export function toPercent(m: Measure): number | null {
  return m.value === null ? null : Math.round(m.value * 100);
}

export interface LevelBucket {
  confirmed: number;
  awaiting: number;
}
export type ValueByLevel = Record<1 | 2 | 4 | 8, LevelBucket>;

/**
 * Value split by *effective* level (the reviewer's confirmed points if reviewed, else the claim),
 * keeping confirmed and awaiting-review value separate. A reviewer score of 0 contributes nothing.
 * Points are summed, never counted, so splitting work into more pieces cannot raise a bar.
 */
export function valueByLevel(outcomes: readonly ScoredOutcome[], reviews: readonly ScoredReview[]): ValueByLevel {
  const latest = latestReviews(reviews);
  const out: ValueByLevel = {
    1: { confirmed: 0, awaiting: 0 },
    2: { confirmed: 0, awaiting: 0 },
    4: { confirmed: 0, awaiting: 0 },
    8: { confirmed: 0, awaiting: 0 },
  };
  for (const o of outcomes) {
    const e = effectivePoints(o, latest);
    if (e.state === "none" || e.points === 0) continue;
    out[e.points as 1 | 2 | 4 | 8][e.state === "confirmed" ? "confirmed" : "awaiting"] += e.points;
  }
  return out;
}
