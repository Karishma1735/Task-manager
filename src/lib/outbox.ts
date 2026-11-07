/**
 * Transactional outbox for viaSocket events.
 *
 *  1. The business transaction calls `enqueue()` — the row commits (or rolls back) with the change.
 *  2. After the commit, `processDue()` delivers pending rows. A delivery failure never touches the business data.
 *  3. Failures retry after 1, 5 and 30 minutes (4 attempts in all), then the row is marked `failed`.
 *
 * Privacy: delivery logs and `last_error` hold only a status code or a short code — never payloads,
 * proof links, webhook URLs, response bodies or exception messages.
 */
import { and, asc, desc, eq, inArray, lte, or, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "@/db";
import { deliveryLog, notifications, type Notification } from "@/db/schema";
import { writeAudit } from "@/lib/audit";
import type { Actor } from "@/lib/auth";
import type { Clock } from "@/lib/clock";
import { conflict, notFound } from "@/lib/errors";
import type { OutboxEvent } from "@/lib/events";
import { EVENT_TYPES, hookUrl, retryDelaysMinutes, sharedToken, type EventType } from "@/lib/viasocket";

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 10_000;
const LEASE_MS = 60_000; // a claimed row is invisible to other workers for this long
const BATCH = 20;

/** Called inside the business transaction. A repeated event id is ignored (deduplication). */
export function enqueue(tx: DbOrTx, e: OutboxEvent, now: Date): { id: number; duplicate: boolean } {
  const at = now.toISOString();
  const row = tx
    .insert(notifications)
    .values({
      eventId: e.eventId,
      type: e.type,
      payloadJson: JSON.stringify(e.payload),
      status: "pending",
      attempts: 0,
      createdAt: at,
      nextAttemptAt: at,
    })
    .onConflictDoNothing({ target: notifications.eventId })
    .returning({ id: notifications.id })
    .get();
  if (row) return { id: row.id, duplicate: false };
  const existing = tx.select({ id: notifications.id }).from(notifications).where(eq(notifications.eventId, e.eventId)).get();
  return { id: existing!.id, duplicate: true };
}

/** Reduce any failure to a short, safe code. */
export function safeError(e: unknown, status?: number): string {
  if (status !== undefined) return `http_${status}`;
  const name = (e as { name?: string } | null)?.name;
  if (name === "AbortError" || name === "TimeoutError") return "timeout";
  return "network_error";
}

function claim(db: Db, id: number, now: Date): Notification | null {
  return db.transaction((tx) => {
    const row = tx.select().from(notifications).where(eq(notifications.id, id)).get();
    if (!row || row.status !== "pending") return null;
    if (row.nextAttemptAt && row.nextAttemptAt > now.toISOString()) return null;
    tx.update(notifications)
      .set({ nextAttemptAt: new Date(now.getTime() + LEASE_MS).toISOString() })
      .where(eq(notifications.id, id))
      .run();
    return row;
  });
}

function record(
  db: Db,
  row: Notification,
  now: Date,
  result: { ok: true; status: number } | { ok: false; error: string; status?: number; final?: boolean },
): "sent" | "retry" | "failed" {
  return db.transaction((tx) => {
    const attempt = row.attempts + 1;
    const at = now.toISOString();
    if (result.ok) {
      tx.update(notifications)
        .set({ status: "sent", attempts: attempt, lastError: null, sentAt: at, nextAttemptAt: null })
        .where(eq(notifications.id, row.id))
        .run();
      tx.insert(deliveryLog).values({ notificationId: row.id, at, attempt, outcome: "sent", httpStatus: result.status, error: null }).run();
      return "sent" as const;
    }
    const delays = retryDelaysMinutes();
    const retryIdx = attempt - 1; // attempt 1 failed -> delays[0]
    const canRetry = !result.final && retryIdx < delays.length;
    if (canRetry) {
      tx.update(notifications)
        .set({
          attempts: attempt,
          lastError: result.error,
          nextAttemptAt: new Date(now.getTime() + delays[retryIdx]! * 60_000).toISOString(),
        })
        .where(eq(notifications.id, row.id))
        .run();
      tx.insert(deliveryLog)
        .values({ notificationId: row.id, at, attempt, outcome: "retry_scheduled", httpStatus: result.status ?? null, error: result.error })
        .run();
      return "retry" as const;
    }
    tx.update(notifications)
      .set({ status: "failed", attempts: attempt, lastError: result.error, nextAttemptAt: null })
      .where(eq(notifications.id, row.id))
      .run();
    tx.insert(deliveryLog)
      .values({ notificationId: row.id, at, attempt, outcome: "failed", httpStatus: result.status ?? null, error: result.error })
      .run();
    return "failed" as const;
  });
}

/** Attempt one delivery. Returns null if the row was not due / already handled. */
export async function deliver(db: Db, id: number, clock: Clock, fetchImpl: Fetch = fetch): Promise<"sent" | "retry" | "failed" | null> {
  const row = claim(db, id, clock());
  if (!row) return null;
  const type = row.type as EventType;
  const url = EVENT_TYPES.includes(type) ? hookUrl(type) : null;
  const token = sharedToken();
  if (!url || !token) {
    // Not configured: nothing to retry until the owner sets it up, so fail immediately.
    return record(db, row, clock(), { ok: false, error: "not_configured", final: true });
  }
  let body: string;
  try {
    // The token is added only here, so it is never stored in the database.
    body = JSON.stringify({ token, ...JSON.parse(row.payloadJson) });
  } catch {
    return record(db, row, clock(), { ok: false, error: "bad_payload", final: true });
  }
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) return record(db, row, clock(), { ok: true, status: res.status });
    return record(db, row, clock(), { ok: false, error: safeError(null, res.status), status: res.status });
  } catch (e) {
    return record(db, row, clock(), { ok: false, error: safeError(e) });
  }
}

/** Deliver everything that is due. Loops so zero-delay retries finish in one call (bounded). */
export async function processDue(db: Db, clock: Clock, fetchImpl: Fetch = fetch): Promise<number> {
  let handled = 0;
  for (let round = 0; round < 8; round++) {
    const nowIso = clock().toISOString();
    const due = db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.status, "pending"), or(sql`${notifications.nextAttemptAt} is null`, lte(notifications.nextAttemptAt, nowIso))))
      .orderBy(asc(notifications.id))
      .limit(BATCH)
      .all();
    if (due.length === 0) break;
    let progressed = 0;
    for (const d of due) {
      if ((await deliver(db, d.id, clock, fetchImpl)) !== null) progressed++;
    }
    handled += progressed;
    if (progressed === 0) break;
  }
  return handled;
}

/** Fire-and-forget after a commit. Never throws, never blocks the response. */
export function kickOutbox(db: Db, clock: Clock, fetchImpl?: Fetch): void {
  if (process.env.VL_DISABLE_OUTBOX === "1") return;
  void processDue(db, clock, fetchImpl).catch(() => {
    console.error("[outbox] delivery pass failed");
  });
}

// ---------- owner-facing operations ----------

export function retryNotification(db: Db, actor: Actor, id: number, now: Date): Notification {
  return db.transaction((tx) => {
    const row = tx.select().from(notifications).where(eq(notifications.id, id)).get();
    if (!row) throw notFound("Notification");
    if (row.status !== "failed") throw conflict("not_failed", "Only failed notifications can be retried");
    const after = tx
      .update(notifications)
      .set({ status: "pending", attempts: 0, lastError: null, nextAttemptAt: now.toISOString() })
      .where(eq(notifications.id, id))
      .returning()
      .get();
    writeAudit(tx, {
      at: now,
      actorId: actor.id,
      action: "notification.retry",
      entity: "notification",
      entityId: id,
      before: { status: row.status, attempts: row.attempts, lastError: row.lastError },
      after: { status: after.status, attempts: after.attempts },
    });
    return after;
  });
}

export interface NotificationView {
  id: number;
  eventId: string;
  type: string;
  status: Notification["status"];
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
  nextAttemptAt: string | null;
  log: { at: string; attempt: number; outcome: string; httpStatus: number | null; error: string | null }[];
}

/** The delivery log as shown in Settings — metadata only (no payloads, no links, no URLs). */
export function listNotifications(db: Db, limit = 50): NotificationView[] {
  const rows = db.select().from(notifications).orderBy(desc(notifications.id)).limit(limit).all();
  if (rows.length === 0) return [];
  const logs = db
    .select()
    .from(deliveryLog)
    .where(inArray(deliveryLog.notificationId, rows.map((r) => r.id)))
    .orderBy(asc(deliveryLog.id))
    .all();
  return rows.map((r) => ({
    id: r.id,
    eventId: r.eventId,
    type: r.type,
    status: r.status,
    attempts: r.attempts,
    lastError: r.lastError,
    createdAt: r.createdAt,
    sentAt: r.sentAt,
    nextAttemptAt: r.status === "pending" ? r.nextAttemptAt : null,
    log: logs
      .filter((l) => l.notificationId === r.id)
      .slice(-6)
      .map((l) => ({ at: l.at, attempt: l.attempt, outcome: l.outcome, httpStatus: l.httpStatus, error: l.error })),
  }));
}

/** A clearly-labelled synthetic event so flows can be tested without real work or Sheet rows. */
export function buildTestEvent(type: EventType, now: Date): OutboxEvent {
  const date = now.toISOString().slice(0, 10);
  const eventId = `test:${type}:${now.getTime()}`;
  const outcomes = [
    {
      title: "TEST EVENT — not real work",
      level: 2,
      level_name: "Progress",
      planned: true,
      status: type === "commit" ? "open" : "done",
      result: "This is a test event sent from Settings.",
      proof_url: "",
      done_means: "Nothing — test only",
      claimed_points: 2,
      confirmed_points: type === "review" ? 2 : null,
    },
  ];
  return {
    eventId,
    type,
    date,
    payload: {
      event_id: eventId,
      type,
      is_test: true,
      date,
      owner_name: "Test Owner",
      reviewer_name: type === "review" ? "Test Reviewer" : undefined,
      committed_points: 2,
      delivered_points: 2,
      promises_kept_pct: 100,
      outcomes,
      highlight: type === "daily_report" ? "TEST EVENT" : "",
      learning: "",
      reviewer_notes: type === "review" ? [{ reviewer: "Test Reviewer", note: "Test note" }] : [],
      report_url: "",
    },
  };
}

export function queueTestEvent(db: Db, actor: Actor, type: EventType, now: Date): number {
  return db.transaction((tx) => {
    const { id } = enqueue(tx, buildTestEvent(type, now), now);
    writeAudit(tx, { at: now, actorId: actor.id, action: "notification.test", entity: "notification", entityId: id, after: { type } });
    return id;
  });
}

