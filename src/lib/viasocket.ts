/**
 * Server-only viaSocket configuration. Webhook URLs and the shared token live only in
 * environment variables and must never reach browser code, logs, or API responses.
 */
export type EventType = "commit" | "daily_report" | "review";
export const EVENT_TYPES: readonly EventType[] = ["commit", "daily_report", "review"];

const HOOK_ENV: Record<EventType, string> = {
  commit: "VIASOCKET_HOOK_COMMIT",
  daily_report: "VIASOCKET_HOOK_REPORT",
  review: "VIASOCKET_HOOK_REVIEW",
};
export const FLOW_NAME: Record<EventType, string> = {
  commit: "ledger_commit",
  daily_report: "ledger_daily_report",
  review: "ledger_review",
};

function allowedHosts(): string[] {
  const extra = (process.env.VIASOCKET_HOST_ALLOWLIST ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return ["flow.sokt.io", ...extra];
}

/** Returns the webhook URL for an event type, or null when it is missing or not an allowed https viaSocket host. */
export function hookUrl(type: EventType): string | null {
  const raw = process.env[HOOK_ENV[type]]?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    // Any host is allowed only for local tests (mock webhook); never in a real production run.
    const anyHost = process.env.VIASOCKET_ALLOW_ANY_HOST === "1" && (process.env.NODE_ENV !== "production" || process.env.VL_ALLOW_TEST_CLOCK === "1");
    if (anyHost) return u.toString();
    if (u.protocol !== "https:" || !allowedHosts().includes(u.hostname)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function sharedToken(): string | null {
  return process.env.VIASOCKET_SHARED_TOKEN?.trim() || null;
}

/** Public base URL used for report links inside events. */
export function appBaseUrl(): string {
  return (process.env.APP_BASE_URL?.trim() || "http://localhost:3000").replace(/\/+$/, "");
}

/** Minutes to wait before retry 1, 2, 3 (spec: 1, 5, 30). Overridable for tests. */
export function retryDelaysMinutes(): number[] {
  const raw = process.env.OUTBOX_RETRY_DELAYS_MIN;
  if (raw) {
    const parsed = raw.split(",").map((s) => Number(s.trim()));
    if (parsed.length && parsed.every((n) => Number.isFinite(n) && n >= 0)) return parsed;
  }
  return [1, 5, 30];
}

export interface WebhookHealth {
  type: EventType;
  flow: string;
  configured: boolean;
}

/** Health without ever revealing a URL or token. */
export function webhookHealth(): { hooks: WebhookHealth[]; tokenConfigured: boolean } {
  return {
    hooks: EVENT_TYPES.map((t) => ({ type: t, flow: FLOW_NAME[t], configured: hookUrl(t) !== null })),
    tokenConfigured: sharedToken() !== null,
  };
}
