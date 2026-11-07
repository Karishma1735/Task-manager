"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { LogoutButton } from "@/components/LogoutButton";
import { api, describeError } from "@/lib/client-api";
import type { NotificationView } from "@/lib/outbox";
import type { WebhookHealth } from "@/lib/viasocket";

interface Data {
  notifications: NotificationView[];
  health: { hooks: WebhookHealth[]; tokenConfigured: boolean };
  commitByHour: number;
  tz: string;
}

const TYPE_LABEL: Record<string, string> = { commit: "Plan committed", daily_report: "Day closed", review: "Reviewer saved" };
const STATUS_STYLE: Record<string, string> = { sent: "border-ok text-ok", pending: "border-warn text-warn", failed: "border-cherry text-cherry" };
const when = (iso: string | null, tz: string) =>
  iso ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: tz }).format(new Date(iso)) : "—";

export function Settings({ initial }: { initial: Data }) {
  const [data, setData] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const r = await api<Data>("GET", "/api/notifications");
    if (r.ok) setData(r.data);
  }, []);

  async function act(key: string, fn: () => ReturnType<typeof api>) {
    setBusy(key);
    setError(null);
    const r = await fn();
    // Delivery runs in the background right after the request; give it a moment, then refresh.
    if (r.ok) await new Promise((res) => setTimeout(res, 600));
    await refresh();
    setBusy(null);
    if (!r.ok) setError(describeError(r.error));
  }

  return (
    <main id="main" className="mx-auto max-w-4xl px-5 py-8 sm:px-8 sm:py-12">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="eyebrow">Value Ledger</p>
          <h1 className="mt-2 text-4xl sm:text-5xl">Settings</h1>
          <p className="mt-1 text-muted">Where events go, and whether they arrived.</p>
        </div>
        <nav aria-label="Navigation" className="flex items-center gap-1">
          <Link className="btn btn-quiet" href="/my-day">My day</Link>
          <Link className="btn btn-quiet" href="/report">Report</Link>
          <LogoutButton />
        </nav>
      </header>

      <div role="alert">{error && <p className="alert alert-error mt-6">{error}</p>}</div>

      <section aria-labelledby="health-h" className="mt-10">
        <h2 id="health-h" className="text-2xl">Webhook health</h2>
        <p className="hint">Addresses and tokens live only on the server and are never shown here.</p>
        <ul className="mt-4 grid gap-3 sm:grid-cols-3">
          {data.health.hooks.map((h) => (
            <li key={h.type} className="card !p-4" data-testid={`hook-${h.type}`}>
              <p className="eyebrow">{h.flow}</p>
              <p className="mt-1 font-bold">{TYPE_LABEL[h.type]}</p>
              <p className={`mt-2 pill ${h.configured ? "border-ok text-ok" : "border-cherry text-cherry"}`}>{h.configured ? "Configured" : "Not configured"}</p>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-sm">
          Shared token:{" "}
          <span className={`pill ${data.health.tokenConfigured ? "border-ok text-ok" : "border-cherry text-cherry"}`}>
            {data.health.tokenConfigured ? "Configured" : "Not configured"}
          </span>
        </p>
        <p className="mt-3 text-sm text-muted">Commit-by hour: {String(data.commitByHour).padStart(2, "0")}:00 ({data.tz}). Set with COMMIT_BY_HOUR on the server.</p>
      </section>

      <section aria-labelledby="test-h" className="mt-10">
        <h2 id="test-h" className="text-2xl">Send a test event</h2>
        <p className="hint">
          Sends one clearly labelled test (<code>is_test: true</code>) to the chosen flow. The flow may post to Slack or send email, so only send
          one when the flow points at a private destination.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          {data.health.hooks.map((h) => (
            <button
              key={h.type}
              className="btn"
              disabled={busy !== null || !h.configured || !data.health.tokenConfigured}
              onClick={() => {
                if (!window.confirm(`Send a test event to ${h.flow}? Its Slack/email/Sheet actions may run.`)) return;
                act(`test-${h.type}`, () => api("POST", "/api/notifications/test", { type: h.type }));
              }}
            >
              Test {h.flow}
            </button>
          ))}
        </div>
      </section>

      <section aria-labelledby="log-h" className="mt-10">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="log-h" className="text-2xl">Notification log</h2>
          <button className="btn btn-quiet" onClick={() => act("refresh", async () => ({ ok: true, data: null }))}>Refresh</button>
        </div>
        {data.notifications.length === 0 ? (
          <p className="card mt-4 text-muted">Nothing has been queued yet.</p>
        ) : (
          <ul className="mt-4 space-y-3">
            {data.notifications.map((n) => (
              <li key={n.id} className="card !p-4" data-testid="notification" data-status={n.status} data-type={n.type}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`pill ${STATUS_STYLE[n.status]}`} data-testid="notification-status">
                    {n.status === "pending" && n.attempts > 0 ? "Retrying" : n.status === "pending" ? "Pending" : n.status === "sent" ? "Sent" : "Failed"}
                  </span>
                  <span className="font-bold">{TYPE_LABEL[n.type] ?? n.type}</span>
                  <span className="text-sm text-muted">{n.eventId}</span>
                </div>
                <p className="mt-2 text-sm text-muted">
                  Queued {when(n.createdAt, data.tz)}
                  {n.sentAt && ` · delivered ${when(n.sentAt, data.tz)}`}
                  {n.nextAttemptAt && ` · next attempt ${when(n.nextAttemptAt, data.tz)}`}
                </p>
                {n.lastError && <p className="mt-1 text-sm text-cherry" data-testid="notification-error">Last error: {n.lastError}</p>}
                {n.log.length > 0 && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-sm font-bold">Delivery attempts</summary>
                    <ul className="mt-1 text-sm">
                      {n.log.map((l, i) => (
                        <li key={i}>
                          #{l.attempt} · {when(l.at, data.tz)} · {l.outcome.replace("_", " ")}
                          {l.httpStatus ? ` · HTTP ${l.httpStatus}` : ""}
                          {l.error ? ` · ${l.error}` : ""}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {n.status === "failed" && (
                  <button className="btn mt-3" disabled={busy !== null} onClick={() => act(`retry-${n.id}`, () => api("POST", `/api/notifications/${n.id}/retry`))}>
                    Retry
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
