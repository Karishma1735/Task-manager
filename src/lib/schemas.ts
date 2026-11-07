import { z } from "zod";
import { isValidLevel, isValidProofUrl } from "@/lib/scoring";

const text = (max: number) => z.string().trim().min(1, "Required").max(max);
const levelSchema = z.number().int().refine(isValidLevel, "Level must be 1, 2, 4 or 8");
const proofSchema = z
  .string()
  .trim()
  .refine(isValidProofUrl, "Proof must be a valid http or https URL");
const goalIdSchema = z.number().int().positive().nullable().optional();

export const addOutcomeSchema = z
  .object({
    title: text(140),
    doneMeans: text(500),
    level: levelSchema,
    goalId: goalIdSchema,
  })
  .strict();

/** Drafts only. The server refuses any edit once the day is locked. */
export const updateOutcomeSchema = z
  .object({
    title: text(140).optional(),
    doneMeans: text(500).optional(),
    level: levelSchema.optional(),
    goalId: goalIdSchema,
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");

export const closeOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("done"), proofUrl: proofSchema, result: text(1000) }).strict(),
  z.object({ status: z.literal("missed"), reason: text(500) }).strict(),
  z.object({ status: z.literal("carried"), reason: text(500) }).strict(),
]);

export const closeDaySchema = z
  .object({
    highlight: text(500),
    learning: z
      .string()
      .trim()
      .max(500)
      .optional()
      .nullable()
      .transform((v) => (v ? v : null)),
  })
  .strict();

export const unplannedSchema = z
  .object({
    title: text(140),
    level: levelSchema,
    result: text(1000),
    proofUrl: proofSchema,
    goalId: goalIdSchema,
  })
  .strict();

export const goalsSchema = z
  .object({
    goals: z
      .array(
        z
          .object({
            id: z.number().int().positive().optional(),
            text: text(200),
            measure: text(300),
          })
          .strict(),
      )
      .max(3, "At most three goals per week"),
  })
  .strict();

export type AddOutcomeInput = z.infer<typeof addOutcomeSchema>;
export type CloseOutcomeInput = z.infer<typeof closeOutcomeSchema>;
