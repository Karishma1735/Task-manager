import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Dates are YYYY-MM-DD strings in the app timezone.
 * Timestamps are ISO-8601 UTC strings (e.g. 2026-11-09T04:30:00.000Z).
 */

export const users = sqliteTable(
  "users",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role", { enum: ["owner", "reviewer"] }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("users_email_unique").on(t.email),
    check("users_role_check", sql`${t.role} in ('owner','reviewer')`),
  ],
);

/** Server-side sessions. `id` is an HMAC of the random cookie token, never the token itself. */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const goals = sqliteTable(
  "goals",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    weekStart: text("week_start").notNull(), // Monday
    text: text("text").notNull(),
    measure: text("measure").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("goals_week_idx").on(t.weekStart)],
);

export const days = sqliteTable("days", {
  date: text("date").primaryKey(),
  lockedAt: text("locked_at"),
  closedAt: text("closed_at"),
  highlight: text("highlight"),
  learning: text("learning"),
});

export const outcomes = sqliteTable(
  "outcomes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    date: text("date")
      .notNull()
      .references(() => days.date),
    position: integer("position").notNull(),
    title: text("title").notNull(),
    doneMeans: text("done_means").notNull(),
    level: integer("level").notNull(),
    goalId: integer("goal_id").references(() => goals.id),
    planned: integer("planned", { mode: "boolean" }).notNull(),
    status: text("status", { enum: ["open", "done", "missed", "carried"] })
      .notNull()
      .default("open"),
    proofUrl: text("proof_url"),
    result: text("result"),
    reason: text("reason"),
    carriedFrom: integer("carried_from"),
    createdAt: text("created_at").notNull(),
    closedAt: text("closed_at"),
  },
  (t) => [
    index("outcomes_date_idx").on(t.date),
    check("outcomes_level_check", sql`${t.level} in (1,2,4,8)`),
    check("outcomes_status_check", sql`${t.status} in ('open','done','missed','carried')`),
  ],
);

export const reviews = sqliteTable(
  "reviews",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    outcomeId: integer("outcome_id")
      .notNull()
      .references(() => outcomes.id),
    reviewerId: integer("reviewer_id")
      .notNull()
      .references(() => users.id),
    confirmedPoints: integer("confirmed_points").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("reviews_outcome_reviewer_unique").on(t.outcomeId, t.reviewerId),
    check("reviews_points_check", sql`${t.confirmedPoints} in (0,1,2,4,8)`),
  ],
);

export const dayNotes = sqliteTable(
  "day_notes",
  {
    date: text("date")
      .notNull()
      .references(() => days.date),
    reviewerId: integer("reviewer_id")
      .notNull()
      .references(() => users.id),
    note: text("note").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.date, t.reviewerId] })],
);

export const notifications = sqliteTable(
  "notifications",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: text("event_id").notNull(), // type:date
    type: text("type").notNull(),
    payloadJson: text("payload_json").notNull(),
    status: text("status", { enum: ["pending", "sent", "failed"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    sentAt: text("sent_at"),
    createdAt: text("created_at").notNull().default("1970-01-01T00:00:00.000Z"),
    /** When the next delivery attempt is due (pending rows only). */
    nextAttemptAt: text("next_attempt_at"),
  },
  (t) => [
    uniqueIndex("notifications_event_unique").on(t.eventId),
    check("notifications_status_check", sql`${t.status} in ('pending','sent','failed')`),
  ],
);

/** Append-only (enforced by SQLite triggers in the migrations). */
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    at: text("at").notNull(),
    actorId: integer("actor_id"),
    action: text("action").notNull(),
    entity: text("entity").notNull(),
    entityId: text("entity_id").notNull(),
    beforeJson: text("before_json"),
    afterJson: text("after_json"),
  },
  (t) => [index("audit_entity_idx").on(t.entity, t.entityId)],
);

/** One row per delivery attempt. Never stores payloads, URLs or response bodies. */
export const deliveryLog = sqliteTable(
  "delivery_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    notificationId: integer("notification_id")
      .notNull()
      .references(() => notifications.id),
    at: text("at").notNull(),
    attempt: integer("attempt").notNull(),
    outcome: text("outcome", { enum: ["sent", "retry_scheduled", "failed"] }).notNull(),
    httpStatus: integer("http_status"),
    error: text("error"),
  },
  (t) => [index("delivery_log_notification_idx").on(t.notificationId)],
);

export type Notification = typeof notifications.$inferSelect;
export type User = typeof users.$inferSelect;
export type Goal = typeof goals.$inferSelect;
export type Day = typeof days.$inferSelect;
export type Outcome = typeof outcomes.$inferSelect;
export type Review = typeof reviews.$inferSelect;
