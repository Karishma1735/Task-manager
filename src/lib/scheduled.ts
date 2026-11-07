/**
 * Status, reminder claims and digest bookkeeping for viaSocket's scheduled flows.
 *
 * The flows only *send*; this module decides whether a message is due and guarantees at most one
 * claim per (kind, date) — so a scheduler that fires twice cannot send twice. Everything is gated
 * by SCHEDULED_REMINDERS_ENABLED (off by default) so nothing can reach a destination until approved.
 */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db";
import { days, deliveryLog, notifications, outcomes } from "@/db/schema";
import { badRequest, conflict, invalid, notFound } from "@/lib/errors";
import { commitDeadline, defaultCfg, type Cfg } from "@/lib/ledger";
import { addDays, isValidDate, localDate, weekStartOf } from "@/lib/time";
import { parseBody } from "@/lib/validate";

export const SCHEDULED_KINDS = ["reminder_morning", "reminder_evening", "weekly_digest"] as const;
export type ScheduledKind = (typeof SCHEDULED_KINDS)[number];

export const EVENING_REMINDER_FROM_HOUR = 17; // 5 pm local — guards against a mis-timed scheduler
export const DIGEST_FROM_HOUR = 17;
const CLAIM_LEASE_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 3;

export const scheduledEnabled = () => process.env.SCHEDULED_REMINDERS_ENABLED === "1";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export function weekdayOf(date: string): (typeof WEEKDAYS)[number] {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!;
}
export const isWorkday = (date: string) => !["Sat", "Sun"].includes(weekdayOf(date));

function localHour(now: Date, tz: string): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(now));
}

// ---------- GET /api/status ----------

export interface StatusView {
  date: string;
  weekday: string;
  isWorkday: boolean;
  tz: string;
  /** The plan has been committed (locked). */
  committed: boolean;
  /** Draft outcomes exist but were not committed. */
  hasDraft: boolean;
  closed: boolean;
  commitDeadlineAt: string;
  /** Whether a reminder of each kind would currently be due. Nothing is sent by reading this. */
  due: { morning: boolean; evening: boolean };
  enabled: boolean;
}

const statusDateSchema = z.union([z.literal("today"), z.string().refine(isValidDate, "Date must be 'today' or YYYY-MM-DD")]);

export function getStatus(db: Db, dateParam: string | null, now: Date, cfg: Cfg = defaultCfg()): StatusView {
  const parsed = statusDateSchema.safeParse(dateParam ?? "today");
  if (!parsed.success) throw badRequest("date must be 'today' or YYYY-MM-DD");
  const today = localDate(now, cfg.tz);
  const date = parsed.data === "today" ? today : parsed.data;
  if (date > addDays(today, 1) || date < addDays(today, -14)) throw invalid("out_of_range", "Date is outside the supported range");
  const day = db.select().from(days).where(eq(days.date, date)).get();
  const drafts = db.select({ id: outcomes.id }).from(outcomes).where(and(eq(outcomes.date, date), eq(outcomes.planned, true))).limit(1).get();
  const committed = Boolean(day?.lockedAt);
  const closed = Boolean(day?.closedAt);
  const deadline = commitDeadline(date, cfg);
  const work = isWorkday(date);
  const isToday = date === today;
  return {
    date,
    weekday: weekdayOf(date),
    isWorkday: work,
    tz: cfg.tz,
    committed,
    hasDraft: !committed && Boolean(drafts),
    closed,
    commitDeadlineAt: deadline.toISOString(),
    due: {
      morning: isToday && work && !committed && now.getTime() < deadline.getTime(),
      evening: isToday && work && !closed && localHour(now, cfg.tz) >= EVENING_REMINDER_FROM_HOUR,
    },
    enabled: scheduledEnabled(),
  };
}

// ---------- POST /api/scheduled/claim and /confirm ----------

const claimSchema = z.object({ kind: z.enum(SCHEDULED_KINDS) }).strict();
const confirmSchema = z
  .object({
    eventId: z.string().regex(/^(reminder_morning|reminder_evening|weekly_digest):\d{4}-\d{2}-\d{2}$/),
    ok: z.boolean(),
    // A short machine code only — never a message, URL or content.
    error: z.string().regex(/^[a-z0-9_]{1,40}$/).optional(),
  })
  .strict();

export type ClaimResult =
  | { send: true; eventId: string; attempt: number }
  | { send: false; reason: string; eventId?: string };

/** Idempotency key: one per kind and date (weekly digest: per week). Morning and evening differ by kind. */
export function scheduledEventId(kind: ScheduledKind, date: string): string {
  return `${kind}:${kind === "weekly_digest" ? weekStartOf(date) : date}`;
}

export function claimScheduled(db: Db, rawInput: unknown, now: Date, cfg: Cfg = defaultCfg()): ClaimResult {
  const { kind } = parseBody(claimSchema, rawInput);
  if (!scheduledEnabled()) return { send: false, reason: "disabled" };
  const today = localDate(now, cfg.tz);
  const hour = localHour(now, cfg.tz);

  // Gate on what is actually due *now*, in the app timezone — a scheduler running in the wrong zone is harmless.
  if (kind === "weekly_digest") {
    if (weekdayOf(today) !== "Fri") return { send: false, reason: "not_friday" };
    if (hour < DIGEST_FROM_HOUR) return { send: false, reason: "too_early" };
  } else {
    if (!isWorkday(today)) return { send: false, reason: "weekend" };
    const day = db.select().from(days).where(eq(days.date, today)).get();
    if (kind === "reminder_morning") {
      if (day?.lockedAt) return { send: false, reason: "already_committed" };
      if (now.getTime() >= commitDeadline(today, cfg).getTime()) return { send: false, reason: "deadline_passed" };
    } else {
      if (day?.closedAt) return { send: false, reason: "already_closed" };
      if (hour < EVENING_REMINDER_FROM_HOUR) return { send: false, reason: "too_early" };
    }
  }

  const eventId = scheduledEventId(kind, today);
  return db.transaction((tx): ClaimResult => {
    const at = now.toISOString();
    const lease = new Date(now.getTime() + CLAIM_LEASE_MS).toISOString();
    const inserted = tx
      .insert(notifications)
      .values({ eventId, type: kind, payloadJson: "{}", status: "pending", attempts: 1, createdAt: at, nextAttemptAt: lease })
      .onConflictDoNothing({ target: notifications.eventId })
      .returning({ id: notifications.id })
      .get();
    if (inserted) return { send: true, eventId, attempt: 1 };

    const row = tx.select().from(notifications).where(eq(notifications.eventId, eventId)).get()!;
    if (row.status === "sent") return { send: false, reason: "already_sent", eventId };
    if (row.attempts >= MAX_ATTEMPTS) return { send: false, reason: "max_attempts", eventId };
    // Another run is (or very recently was) handling it: a duplicate scheduler execution must not send again.
    if (row.status === "pending" && row.nextAttemptAt && row.nextAttemptAt > at) return { send: false, reason: "in_progress", eventId };
    // Failed, or a claim whose flow never reported back (lease expired): allow a retry.
    tx.update(notifications)
      .set({ status: "pending", attempts: row.attempts + 1, nextAttemptAt: lease, lastError: null })
      .where(eq(notifications.id, row.id))
      .run();
    return { send: true, eventId, attempt: row.attempts + 1 };
  });
}

/** The flow reports the outcome of its send. Idempotent for a row already marked sent. */
export function confirmScheduled(db: Db, rawInput: unknown, now: Date): { status: string } {
  const input = parseBody(confirmSchema, rawInput);
  return db.transaction((tx) => {
    const row = tx.select().from(notifications).where(eq(notifications.eventId, input.eventId)).get();
    if (!row) throw notFound("Scheduled event");
    if (row.status === "sent") return { status: "sent" };
    if (row.status === "failed" && input.ok) throw conflict("already_failed", "Claim again before confirming a retry");
    const at = now.toISOString();
    if (input.ok) {
      tx.update(notifications).set({ status: "sent", sentAt: at, lastError: null, nextAttemptAt: null }).where(eq(notifications.id, row.id)).run();
      tx.insert(deliveryLog).values({ notificationId: row.id, at, attempt: row.attempts, outcome: "sent", httpStatus: null, error: null }).run();
      return { status: "sent" };
    }
    const error = input.error ?? "flow_failed";
    // Failed rows can be claimed again (up to MAX_ATTEMPTS); the lease is cleared so the next run may retry at once.
    tx.update(notifications).set({ status: "failed", lastError: error, nextAttemptAt: null }).where(eq(notifications.id, row.id)).run();
    tx.insert(deliveryLog).values({ notificationId: row.id, at, attempt: row.attempts, outcome: "failed", httpStatus: null, error }).run();
    return { status: "failed" };
  });
}
