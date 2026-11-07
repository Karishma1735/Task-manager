/**
 * Event payload builders. Pure functions of database state; they run inside the business transaction
 * so the outbox row and the change commit (or roll back) together.
 * The shared token is NOT part of the stored payload: it is added only at send time.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import type { DbOrTx } from "@/db";
import { dayNotes, days, goals, outcomes, reviews, users, type Outcome } from "@/db/schema";
import type { Cfg } from "@/lib/ledger";
import {
  isDelivered,
  isValidProofUrl,
  LEVEL_NAMES,
  latestReviews,
  promisesKept,
  toPercent,
  effectivePoints,
  valueDelivered,
  type ScoredOutcome,
  type ScoredReview,
} from "@/lib/scoring";
import { weekStartOf } from "@/lib/time";
import { appBaseUrl, type EventType } from "@/lib/viasocket";

export interface OutboxEvent {
  eventId: string;
  type: EventType;
  date: string;
  payload: Record<string, unknown>;
}

const toScored = (o: Outcome): ScoredOutcome => ({
  id: o.id,
  level: o.level,
  planned: o.planned,
  status: o.status,
  proofUrl: o.proofUrl,
  result: o.result,
  goalId: o.goalId,
});

const levelName = (n: number) => LEVEL_NAMES[n as 1 | 2 | 4 | 8] ?? String(n);

function ownerName(tx: DbOrTx): string {
  return tx.select({ name: users.name }).from(users).where(eq(users.role, "owner")).limit(1).get()?.name ?? "Owner";
}

const reportUrl = (date: string) => `${appBaseUrl()}/report?week=${weekStartOf(date)}`;

function goalText(tx: DbOrTx, id: number | null): string | null {
  if (id === null) return null;
  return tx.select({ text: goals.text }).from(goals).where(eq(goals.id, id)).get()?.text ?? null;
}

export function buildCommitEvent(tx: DbOrTx, date: string, cfg: Cfg): OutboxEvent {
  const planned = tx
    .select()
    .from(outcomes)
    .where(and(eq(outcomes.date, date), eq(outcomes.planned, true)))
    .orderBy(asc(outcomes.position))
    .all();
  const day = tx.select().from(days).where(eq(days.date, date)).get();
  return {
    eventId: `commit:${date}`,
    type: "commit",
    date,
    payload: {
      event_id: `commit:${date}`,
      type: "commit",
      date,
      owner_name: ownerName(tx),
      committed_at: day?.lockedAt ?? null,
      commit_by: `${String(cfg.commitByHour).padStart(2, "0")}:00 ${cfg.tz}`,
      committed_points: planned.reduce((s, o) => s + o.level, 0),
      outcomes: planned.map((o) => ({
        title: o.title,
        done_means: o.doneMeans,
        level: o.level,
        level_name: levelName(o.level),
        planned: true,
        status: "open",
        weekly_goal: goalText(tx, o.goalId),
      })),
      report_url: reportUrl(date),
    },
  };
}

export function buildDailyReportEvent(tx: DbOrTx, date: string): OutboxEvent {
  const rows = tx.select().from(outcomes).where(eq(outcomes.date, date)).orderBy(asc(outcomes.position)).all();
  const day = tx.select().from(days).where(eq(days.date, date)).get();
  const scored = rows.map(toScored);
  const planned = scored.filter((o) => o.planned);
  const kept = promisesKept(planned);
  // The day is closed before any review can exist, so everything delivered is "claimed, awaiting review".
  const delivered = valueDelivered(scored, []);
  return {
    eventId: `daily_report:${date}`,
    type: "daily_report",
    date,
    payload: {
      event_id: `daily_report:${date}`,
      type: "daily_report",
      date,
      owner_name: ownerName(tx),
      committed_points: kept.denominator,
      delivered_points: delivered.total,
      promised_delivered_points: kept.numerator,
      unplanned_points: scored.filter((o) => !o.planned && isDelivered(o)).reduce((s, o) => s + o.level, 0),
      promises_kept_pct: toPercent(kept),
      verification: "awaiting_review",
      outcomes: rows.map((o) => ({
        title: o.title,
        level: o.level,
        level_name: levelName(o.level),
        planned: o.planned,
        status: o.status,
        result: o.result ?? o.reason ?? "",
        proof_url: isValidProofUrl(o.proofUrl) ? o.proofUrl!.trim() : "",
      })),
      highlight: day?.highlight ?? "",
      learning: day?.learning ?? "",
      closed_at: day?.closedAt ?? null,
      report_url: reportUrl(date),
    },
  };
}

export interface ReviewChange {
  kind: "score" | "note";
  outcomeId?: number;
  reviewerId: number;
}

/** `revision` must be unique and increasing per change (we use the audit-log row id). */
export function buildReviewEvent(tx: DbOrTx, date: string, revision: number, change: ReviewChange): OutboxEvent {
  const rows = tx.select().from(outcomes).where(eq(outcomes.date, date)).orderBy(asc(outcomes.position)).all();
  const reviewRows: ScoredReview[] = rows.length
    ? tx
        .select({ outcomeId: reviews.outcomeId, confirmedPoints: reviews.confirmedPoints, updatedAt: reviews.updatedAt })
        .from(reviews)
        .where(inArray(reviews.outcomeId, rows.map((o) => o.id)))
        .all()
    : [];
  const latest = latestReviews(reviewRows);
  const scored = rows.map(toScored);
  const total = valueDelivered(scored, reviewRows);
  const reviewer = tx.select({ name: users.name }).from(users).where(eq(users.id, change.reviewerId)).get()?.name ?? "Reviewer";
  const notes = tx
    .select({ reviewerId: dayNotes.reviewerId, note: dayNotes.note })
    .from(dayNotes)
    .where(eq(dayNotes.date, date))
    .all();
  const names = new Map(tx.select({ id: users.id, name: users.name }).from(users).all().map((u) => [u.id, u.name]));
  const changed = change.outcomeId ? rows.find((o) => o.id === change.outcomeId) : undefined;
  const id = `review:${date}:${revision}`;
  return {
    eventId: id,
    type: "review",
    date,
    payload: {
      event_id: id,
      type: "review",
      date,
      owner_name: ownerName(tx),
      reviewer_name: reviewer,
      change: change.kind,
      changed_outcome: changed
        ? {
            title: changed.title,
            claimed_points: changed.level,
            confirmed_points: latest.get(changed.id)?.confirmedPoints ?? null,
          }
        : null,
      outcomes: rows
        .filter((o) => isDelivered(toScored(o)))
        .map((o) => {
          const e = effectivePoints(toScored(o), latest);
          return {
            title: o.title,
            planned: o.planned,
            claimed_points: o.level,
            confirmed_points: e.state === "confirmed" ? e.points : null,
            status: e.state === "confirmed" ? "confirmed" : "awaiting_review",
          };
        }),
      confirmed_points_total: total.confirmed,
      awaiting_review_points_total: total.awaiting,
      reviewer_notes: notes.map((n) => ({ reviewer: names.get(n.reviewerId) ?? "Reviewer", note: n.note })),
      report_url: reportUrl(date),
    },
  };
}
