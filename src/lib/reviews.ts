/** Reviewer-side writes. Only reviewers may call these; the owner can read but never change them. */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db";
import { dayNotes, days, outcomes, reviews } from "@/db/schema";
import { writeAudit } from "@/lib/audit";
import { requireRole, type Actor } from "@/lib/auth";
import { conflict, invalid, notFound } from "@/lib/errors";
import { assertDateParam } from "@/lib/ledger";
import { isDelivered, isValidConfirmedPoints } from "@/lib/scoring";
import { parseBody } from "@/lib/validate";

const reviewSchema = z
  .object({
    confirmedPoints: z
      .number()
      .int()
      .refine(isValidConfirmedPoints, "Confirmed points must be 0, 1, 2, 4 or 8"),
  })
  .strict();

const noteSchema = z.object({ note: z.string().trim().min(1, "Required").max(1000) }).strict();

/** Create or change the signed-in reviewer's confirmed points for a delivered outcome. */
export function putReview(db: Db, actor: Actor | null, outcomeId: number, rawInput: unknown, now: Date) {
  const reviewer = requireRole(actor, "reviewer");
  const input = parseBody(reviewSchema, rawInput);
  return db.transaction((tx) => {
    const o = tx.select().from(outcomes).where(eq(outcomes.id, outcomeId)).get();
    if (!o) throw notFound("Outcome");
    if (!isDelivered(o)) {
      throw invalid("not_delivered", "Only delivered outcomes (done, with proof and a result) can be scored");
    }
    const day = tx.select().from(days).where(eq(days.date, o.date)).get();
    if (!day?.closedAt) throw conflict("day_not_closed", "The owner has not closed this day yet");

    const before = tx
      .select()
      .from(reviews)
      .where(and(eq(reviews.outcomeId, outcomeId), eq(reviews.reviewerId, reviewer.id)))
      .get();
    if (before && before.confirmedPoints === input.confirmedPoints) return { review: before, changed: false };

    const at = now.toISOString();
    const after = before
      ? tx.update(reviews).set({ confirmedPoints: input.confirmedPoints, updatedAt: at }).where(eq(reviews.id, before.id)).returning().get()
      : tx.insert(reviews).values({ outcomeId, reviewerId: reviewer.id, confirmedPoints: input.confirmedPoints, updatedAt: at }).returning().get();
    writeAudit(tx, {
      at: now,
      actorId: reviewer.id,
      action: before ? "review.update" : "review.create",
      entity: "review",
      entityId: after.id,
      before: before ? { ...before, claimedLevel: o.level } : { outcomeId, claimedLevel: o.level },
      after,
    });
    return { review: after, changed: true };
  });
}

/** Create or replace the signed-in reviewer's note on a day. */
export function putDayNote(db: Db, actor: Actor | null, date: string, rawInput: unknown, now: Date) {
  const reviewer = requireRole(actor, "reviewer");
  assertDateParam(date);
  const input = parseBody(noteSchema, rawInput);
  return db.transaction((tx) => {
    const day = tx.select().from(days).where(eq(days.date, date)).get();
    if (!day) throw notFound("Day");
    const before = tx
      .select()
      .from(dayNotes)
      .where(and(eq(dayNotes.date, date), eq(dayNotes.reviewerId, reviewer.id)))
      .get();
    if (before && before.note === input.note) return { note: before, changed: false };
    const at = now.toISOString();
    const after = before
      ? tx.update(dayNotes).set({ note: input.note, updatedAt: at }).where(and(eq(dayNotes.date, date), eq(dayNotes.reviewerId, reviewer.id))).returning().get()
      : tx.insert(dayNotes).values({ date, reviewerId: reviewer.id, note: input.note, updatedAt: at }).returning().get();
    writeAudit(tx, {
      at: now,
      actorId: reviewer.id,
      action: before ? "day_note.update" : "day_note.create",
      entity: "day_note",
      entityId: `${date}:${reviewer.id}`,
      before,
      after,
    });
    return { note: after, changed: true };
  });
}
