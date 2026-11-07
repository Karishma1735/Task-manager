# viaSocket integration (Phase 3)

Value Ledger server → outbox (`notifications` table) → viaSocket webhook flow → Slack / Gmail / Google Sheets.
The browser never calls viaSocket and never sees a webhook URL or token.

## Events

| `type` | Flow | Fired when | `event_id` |
|---|---|---|---|
| `commit` | `ledger_commit` | owner commits a day | `commit:YYYY-MM-DD` |
| `daily_report` | `ledger_daily_report` | owner closes a day | `daily_report:YYYY-MM-DD` |
| `review` | `ledger_review` | reviewer saves points or a day note | `review:YYYY-MM-DD:<audit_id>` (new id per change) |

Test events (Settings → "Send a test event") use `event_id = test:<type>:<ms>` and carry `"is_test": true`.
Flows must **skip the Google Sheet row when `is_test` is true**.

Every request body is JSON: `{ "token": "<VIASOCKET_SHARED_TOKEN>", "event_id", "type", "date", "owner_name", ... }`.
Fields per type are built in `src/lib/events.ts` (`daily_report` follows the spec example plus `delivered_points`,
`promised_delivered_points`, `unplanned_points`, `verification`, `closed_at`; `review` adds `reviewer_name`, `change`,
`changed_outcome`, per-outcome `claimed_points`/`confirmed_points`, totals and `reviewer_notes`; review messages carry no proof links).
`promises_kept_pct` is `null` when nothing was committed.

## Delivery guarantees

- The outbox row is written in the **same transaction** as the change (no change → no event; no event row → no change).
- Delivery happens after commit and never blocks or rolls back the business action.
- Retries after 1, 5 and 30 minutes (4 attempts), then `failed`; Settings shows it with a Retry button (owner only).
- At-least-once: if viaSocket received a request but the response was lost, the event is sent again with the **same `event_id`**.
  Flows must therefore be idempotent on `event_id` — in particular **look up the Sheet for `event_id` before adding a row**.
- Logs (`delivery_log`, `last_error`, console) hold only codes such as `http_500`, `timeout`, `network_error`, `not_configured`.

## Server configuration

`VIASOCKET_HOOK_COMMIT`, `VIASOCKET_HOOK_REPORT`, `VIASOCKET_HOOK_REVIEW` (https://flow.sokt.io/func/<script_id>),
`VIASOCKET_SHARED_TOKEN`, `APP_BASE_URL`. Optional: `OUTBOX_RETRY_DELAYS_MIN` (default `1,5,30`),
`VIASOCKET_HOST_ALLOWLIST` (extra allowed hostnames). A missing hook or token marks events `failed: not_configured`.

## Building the flows (manually, or via the viaSocket connector)

For each flow: webhook trigger → **guard step** → actions. Step code rules: lowercase_underscore step names, read earlier
steps by full path (`context?.res?.step?.field`), `if` guards (no try/catch), no imports, under 58 s, markdown `console.log`, end with `return`.

1. `guard`: if `context?.req?.body?.token` (check the trigger's actual path) !== the shared token → `return { stop: true }` and do nothing else.
   Also stop when `type` does not match the flow.
2. `ledger_commit`: Slack message (plan: outcomes with level names and done-means) + email to the private test address.
3. `ledger_daily_report`: Slack message (scorecard, proof links), email, then **Sheets: find row where `event_id` matches; add a row only if none**.
   Columns: `event_id, date, committed_points, delivered_points, promises_kept_pct, highlight, logged_at`. Skip when `is_test`.
4. `ledger_review`: Slack + email to the owner: confirmed vs claimed per outcome, reviewer notes.
Use **private** destinations only (a private channel or DM, a test inbox, a test sheet) until the project is public.

---

# Phase 4: scheduled flows (reminders and weekly digest)

**Status: server side done and tested; the two viaSocket flows are NOT created yet** (see "Blockers" below).

## Server endpoints (all need the `x-reminder-token: <REMINDER_TOKEN>` header)

| Endpoint | Purpose |
|---|---|
| `GET /api/status?date=today` | `{date, weekday, isWorkday, committed, hasDraft, closed, commitDeadlineAt, due:{morning, evening}, enabled}`. Read-only, no work content. |
| `POST /api/scheduled/claim` `{kind}` | `kind` ∈ `reminder_morning`, `reminder_evening`, `weekly_digest`. Returns `{send:true,eventId,attempt}` or `{send:false,reason}`. |
| `POST /api/scheduled/confirm` `{eventId, ok, error?}` | The flow reports its send result. `error` is a short code like `slack_error`. |
| `GET /api/report?week=YYYY-MM-DD[&digest=1]` | The weekly report (same JSON as the Report screen). `digest=1` adds `digest.text`, `digest.subject`, `digest.snapshot`. |

Security: a token in the URL is refused (400); missing/wrong token 401; 10 failures per 15 min per IP then 429; token not configured (or < 16 chars) 503.
The token is compared in constant time and never logged or returned. `POST` routes skip the browser Origin check because they carry no cookie.

## Idempotency and the server-side guards

The flow decides nothing about *whether* to send — the server does, so a scheduler that fires twice (or in the wrong time zone) is harmless:

- `reminder_morning:<date>`, `reminder_evening:<date>`, `weekly_digest:<monday>` — different keys for morning/evening; one digest per week.
- First claim → `send:true`; a second claim while the first is running (15-minute lease) → `in_progress`; after `confirm ok` → `already_sent` forever.
- A failed send (`confirm ok:false`) can be claimed again, up to 3 attempts, then `max_attempts`. A claim never confirmed becomes claimable after the lease.
- Gates (evaluated in `APP_TZ`, never in the scheduler's zone): Mon–Fri only (`weekend`); morning only before the commit deadline (`deadline_passed`) and only if not committed (`already_committed`); evening only from 17:00 (`too_early`) and only if the day is open (`already_closed`); digest on Friday from 17:00 (`not_friday`, `too_early`).
- **`SCHEDULED_REMINDERS_ENABLED` must be `1`**; otherwise every claim returns `disabled`. It is off by default.

## `ledger_reminders` (one flow, cron `30 10,18 * * 1-5`)

1. `get_status` — GET `/api/status?date=today` with the token header. Stop if the request fails (non-2xx) or `isWorkday` is false.
2. `pick_kind` — `morning` if `due.morning`; else `evening` if `due.evening`; else stop. (Chosen from the server's flags, not the flow's clock.)
3. `claim` — POST `/api/scheduled/claim` `{kind:"reminder_morning"|"reminder_evening"}`. Stop unless `send` is true.
4. `send_*` — private Slack message and/or email **only to approved test destinations**: "Commit today's plan before 11:00" / "Close your day: write the most valuable thing delivered".
5. `confirm` — POST `/api/scheduled/confirm` with `{eventId, ok:true}`; on any failure `{eventId, ok:false, error:"<code>"}`.

## `ledger_weekly_digest` (cron `30 17 * * 5`)

1. `get_digest` — GET `/api/report?digest=1` (current week) with the token header. Stop on non-2xx.
2. `claim` — `{kind:"weekly_digest"}`; stop unless `send`.
3. `send_digest` — email/post `data.digest.text` (subject `data.digest.subject`) to the approved private destination.
4. `confirm`.
Friday's digest is a **snapshot** (`digest.snapshot.label`: "SNAPSHOT as of 5:30 PM Asia/Kolkata — today is still open…") unless the day is already closed.

Step-code rules (from the viaSocket docs): lowercase_underscore names; read earlier steps by full path (`context?.res?.step?.field`); `if` guards, no try/catch; markdown `console.log`; end with `return`. Never put the token in step code literally if the flow has a secret store (undocumented — see below); never log it.

## Blockers (why the flows are not created)

1. **The app is not reachable from viaSocket.** Flows call `/api/status` and `/api/report` over the internet. The project must stay private until 15 Nov and nothing is deployed, so there is no URL to call. Deploying is Phase 5.
2. **No approved destination is connected.** `karishma1726@gmail.com` is not a connected Gmail or Sheets account (only two other Gmail accounts exist), and Slack was skipped.
3. **Undocumented in the connector's docs** (so not assumed): (a) the time zone in which `cronStatement` is evaluated; (b) whether step code may call `fetch`, or an HTTP/API app action must be used; (c) how to store a secret for the flow. Check (a) with one dry run in run history before relying on it. If cron runs in UTC, use `0 5,13 * * 1-5` (10:30/18:30 IST) and `0 12 * * 5` (17:30 IST). The server's gates make a wrong zone *skip* a reminder rather than send at the wrong time.
4. Nothing may be sent without explicit approval: keep `SCHEDULED_REMINDERS_ENABLED=0` until destinations are approved.

## Server configuration

`REMINDER_TOKEN` (≥ 16 chars), `SCHEDULED_REMINDERS_ENABLED` (default off). Both are shown (configured / enabled — never the values) in Settings.
