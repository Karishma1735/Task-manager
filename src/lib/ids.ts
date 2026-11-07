import { badRequest } from "@/lib/errors";

export function parseId(raw: string | undefined): number {
  if (!raw || !/^\d{1,12}$/.test(raw)) throw badRequest("Invalid id");
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) throw badRequest("Invalid id");
  return n;
}
