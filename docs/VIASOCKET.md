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
