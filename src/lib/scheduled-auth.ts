/**
 * Authentication for viaSocket's scheduled flows. They carry no cookie: they send the shared
 * REMINDER_TOKEN in the `x-reminder-token` header. Tokens in URLs are refused, failures are rate-limited,
 * and the token is never logged or echoed.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { ApiError, unauthorized } from "@/lib/errors";
import { AttemptLimiter } from "@/lib/rate-limit";

export const TOKEN_HEADER = "x-reminder-token";
export const tokenLimiter = new AttemptLimiter(10, 15 * 60 * 1000);

const digest = (s: string) => createHash("sha256").update(s).digest();

export function reminderToken(): string | null {
  const t = process.env.REMINDER_TOKEN?.trim();
  return t && t.length >= 16 ? t : null;
}

export const hasTokenHeader = (req: Request) => req.headers.has(TOKEN_HEADER);

export function ipOf(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "local";
}

/** Throws the right ApiError unless the request carries the correct REMINDER_TOKEN header. */
export function assertScheduledAuth(req: Request, now: Date): void {
  const url = new URL(req.url);
  if (["token", "reminder_token", "reminderToken", "access_token"].some((k) => url.searchParams.has(k))) {
    throw new ApiError(400, "token_in_url", "Send the token in the x-reminder-token header, never in the URL");
  }
  const expected = reminderToken();
  if (!expected) throw new ApiError(503, "scheduled_disabled", "Scheduled endpoints are not configured on this server");
  const ip = ipOf(req);
  const wait = tokenLimiter.retryAfterMs(ip, now.getTime());
  if (wait > 0) {
    throw new ApiError(429, "rate_limited", "Too many failed attempts. Try again later.", { retryAfterSeconds: Math.ceil(wait / 1000) });
  }
  const given = req.headers.get(TOKEN_HEADER) ?? "";
  // Compare fixed-length digests in constant time so neither length nor content leaks through timing.
  if (!given || !timingSafeEqual(digest(given), digest(expected))) {
    tokenLimiter.fail(ip, now.getTime());
    throw unauthorized();
  }
}
