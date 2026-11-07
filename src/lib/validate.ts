import type { z } from "zod";
import { ApiError } from "@/lib/errors";

/** Validate untrusted input; failures are always 422 with per-field issues. */
export function parseBody<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new ApiError(422, "validation_failed", "Validation failed", {
      issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return r.data;
}
