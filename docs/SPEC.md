Value Ledger: build plan for Claude Code
7 Nov 2026 · @Prashant
Purpose
The Value Ledger scores the value of one person's daily work, not the number of tasks, so a manager can judge it in about ten seconds. It has one owner (the employee) and one or more reviewers (the boss or mentor).
The rule behind it comes from the owner's boss: more tasks do not mean more productivity, and a higher task count does not earn a higher rating. So the app never scores a task count and never shows one as a headline number.
Four principles carry that rule into the design.
1. Promise first. The owner commits to at most three outcomes before 11:00, and the plan is locked once committed.
2. Value, not volume. Every outcome is worth 1, 2, 4 or 8 points, so one multiplier outweighs eight upkeep tasks.
3. Proof or nothing. An outcome earns points only when it is closed as done with a proof link and a note on what changed.
4. The reviewer has the last word. The boss confirms or changes the points for each delivered outcome, and the app shows how far the owner's claims drift from his.
A working prototype exists as a single HTML page on claude.ai (Value ledger prototype). Reuse its scoring logic and wording; this plan replaces its hosting and storage with a standalone app.
The daily loop
Every working day follows one loop: commit, work, close each outcome with proof, close the day, then the reviewer confirms. All times use the owner's timezone (default Asia/Kolkata), and the server clock is the only clock that counts.
Once a week. On Monday, up to three weekly goals are set. Each has a short text and a "measured by" line, for example "Launch the Zoho Books plug: published with 10 actions, used in 5 flows".
Each day.
1. Commit (by 11:00). The owner adds one to three outcomes. Each has a title, a "done means" line anyone can check, a value level (1, 2, 4 or 8) and an optional weekly goal. Pressing Commit stamps the server time and locks title, definition and level. A plan can only be made for today or tomorrow, never backdated.
2. Work. There are no timers and no task ticking during the day. Urgent work that was not in the plan is logged as unplanned, with a value level, a result and a proof link. It counts only because it has proof.
3. Close each committed outcome in one of three ways. Done needs a proof link and one or two sentences on what changed. Missed needs a reason. Carry to tomorrow needs a reason and creates a fresh open outcome tomorrow, if tomorrow is not yet locked and has fewer than three.
4. Close the day. This unlocks only when every committed outcome is closed. The owner writes the most valuable thing delivered (required) and one thing learned (optional). The server stamps the close time.
5. Review. The reviewer opens the report, sees each delivered outcome with its proof, and confirms points of 0, 1, 2, 4 or 8. The default is the owner's claim, so the reviewer only acts where he disagrees. He can add a short note to the day.
Outcomes carried over count as not delivered on the day they were committed. That keeps the promises-kept number honest.
Scoring rules
Value is judged per outcome on a four-step scale, and every measure on the report is computed from the rules below. Put all of this in one pure module (for example lib/scoring.ts) with unit tests, so the numbers can be audited.
Points
Level
Meaning
1
Upkeep
Keeps things running: replies, routine fixes, meetings
2
Progress
A real step toward a goal that nobody can use yet
4
Shipped
Something other people can use today
8
Multiplier
Keeps paying back: saves hours every week, unblocks a team or wins a customer
Definitions.
• A delivered outcome has status done, a proof URL and a result note. Anything else scores zero.
• The effective points of a delivered outcome are the reviewer's confirmed points if it has been reviewed (latest review wins), otherwise the claimed level, shown as awaiting review.
• Value delivered for a week is the sum of effective points of its delivered outcomes. Show it as "N confirmed plus M awaiting review".
The six measures on the report.
Measure
Formula
What it tells the boss
Promises kept
Claimed points of delivered committed outcomes ÷ claimed points of all committed outcomes
Reliability, weighted so skipping a big outcome hurts more
High-leverage share
Effective points from outcomes at 4 or 8 ÷ value delivered
Whether time goes to work that matters
On goal
Effective points tied to a weekly goal ÷ value delivered
Whether the work points where the team is headed
Claim accuracy
Confirmed points ÷ claimed points, over reviewed outcomes only
Whether the owner rates their own work honestly; above 100% if the boss raises a score
Unplanned share
Effective points of unplanned outcomes ÷ value delivered
How much of the week was reaction, not plan
Rhythm
Days committed by 11:00 ÷ days committed, plus days closed the same day
Whether the habit holds
Deliberately absent: task count, hours logged, streaks and any score that rises when work is split into smaller pieces. Splitting does not help, because points belong to an outcome and the reviewer can set a trivial one to 0.
Anti-gaming rules, enforced on the server, not in the browser.
• Maximum three committed outcomes per day.
• Committed outcomes cannot be edited or deleted after the lock, except by closing them.
• Plans cannot be made for past days, and closing stamps the server time.
• Every state change is written to an append-only audit log.
Screens
The app has four screens, and the report must pass a ten-second test: with no scrolling, the boss sees value delivered, promises kept and whether the week has been reviewed.
Screen
Who sees it
What it shows
Main actions
Sign in
Everyone
Email and password
Sign in
My day
Owner only
The week's goals, today's plan, committed outcomes, unplanned work, the close-the-day form
Add outcome, Commit, Done / Missed / Carry, Log unplanned, Close the day, Copy today's report
Report
Owner and reviewers; reviewers land here
Headline value, circles per delivered outcome, six measures, eight-week stacked bars by level, day-by-day log with proof links
Week navigation, Confirm points and add a note (reviewers), Copy this week's report
Settings
Owner only
Notification log (sent, failed, retry), webhook health, commit-by hour
Retry failed notification, Send test event
Report layout, top to bottom.
1. Headline: value points delivered this week, with "confirmed" and "awaiting review" shown separately.
2. A row of circles, one per delivered outcome, sized by points. A green ring means the reviewer confirmed it; a dashed empty circle means he scored it 0.
3. The six measures in a grid, each with its formula in one line underneath.
4. Eight-week stacked bars, split by level, so the mix of work is visible, not only the total.
5. Weekly goals.
6. Day by day, newest first: promised against delivered, every proof link, the owner's "most valuable" line, and the reviewer's points and note.
Look and feel. The circles are the one memorable device: size equals worth, so a week of small circles looks different from a week with one large one. Keep the rest quiet. Use Bricolage Grotesque for headings and Atkinson Hyperlegible for text, support light and dark mode, work on a phone, and keep visible keyboard focus. Do not show a task count anywhere. The prototype's CSS in the linked page is a good starting point.
Data model
Seven tables hold everything, and the server is the only writer. Dates are YYYY-MM-DD in the app timezone; timestamps are stored in UTC.
Table
Key fields
Written by
users
id, name, email, password_hash, role (owner or reviewer)
Seed script
goals
id, week_start (Monday), text, measure
Owner and reviewers
days
date (primary key), locked_at, closed_at, highlight, learning
Owner
outcomes
id, date, position, title, done_means, level (1, 2, 4, 8), goal_id, planned (bool), status (open, done, missed, carried), proof_url, result, reason, carried_from, created_at, closed_at
Owner
reviews
id, outcome_id, reviewer_id, confirmed_points (0, 1, 2, 4, 8), updated_at; unique on outcome_id and reviewer_id
Reviewers
day_notes
date, reviewer_id, note, updated_at
Reviewers
notifications
id, event_id (unique, type:date), type, payload_json, status (pending, sent, failed), attempts, last_error, sent_at
Server
Plus an append-only audit_log table (id, at, actor_id, action, entity, entity_id, before_json, after_json). Never update or delete its rows.
Permission rules, checked on the server for every request.
• Only the owner writes days and outcomes. A reviewer who tries gets a 403.
• Only reviewers write reviews and day notes. The owner can read them but cannot change them.
• Outcome fields title, done_means, level, goal_id and planned are immutable once the day has locked_at. Only closing fields (status, proof_url, result, reason, closed_at) change, and only while the outcome is open.
• A day cannot be closed while any committed outcome is open.
• Validate everything: proof_url must be an http or https URL, level must be one of 1, 2, 4, 8, and confirmed_points one of 0, 1, 2, 4, 8.
• Escape all user text when rendering, because the report is read by other people.
Stack and architecture
Build a standalone web app with its own server and database, not a claude.ai page, because the boss needs a normal URL and the server must enforce the rules and call viaSocket. The stack below is a default; Claude Code may swap a piece if it keeps the same behaviour.
Only the server writes data and calls viaSocket. The two scheduled flows call back to the server's status and report endpoints, using a secret token.
Part
Default choice
Why
Framework
Next.js (App Router) with TypeScript
One codebase for pages and API routes
Database
SQLite through Drizzle, or Postgres if the host offers it
Seven small tables; no heavy infrastructure
Auth
Cookie sessions, bcrypt passwords, two roles
Only two kinds of user
Scoring
One pure module, lib/scoring.ts, tested with Vitest
The numbers must be auditable
End-to-end tests
Playwright: commit, close, review
Protects the core loop
Hosting
Deploy with Embarko; read its quickstart first at https://embarko.ai/docs/quickstart.md
viaSocket's docs point to it for finished apps
Environment variables. Never put these in browser code.
• APP_TZ (default Asia/Kolkata) and COMMIT_BY_HOUR (default 11)
• SESSION_SECRET, OWNER_EMAIL, OWNER_PASSWORD, REVIEWER_EMAIL, REVIEWER_PASSWORD
• VIASOCKET_HOOK_COMMIT, VIASOCKET_HOOK_REPORT, VIASOCKET_HOOK_REVIEW, the webhook URLs of the three event flows
• VIASOCKET_SHARED_TOKEN, the secret every flow checks in its first step
• REMINDER_TOKEN, the secret viaSocket's scheduled flows send when they read the app's status endpoint
Server API routes.
• POST /api/days/:date/outcomes, POST /api/days/:date/commit, POST /api/outcomes/:id/close, POST /api/days/:date/close, POST /api/days/:date/unplanned
• PUT /api/reviews/:outcomeId, PUT /api/day-notes/:date, PUT /api/goals/:weekStart
• GET /api/report?week=YYYY-MM-DD, which returns the six measures already computed
• GET /api/status?date=today, which returns whether today has a plan and whether it is closed, and requires the REMINDER_TOKEN header
• POST /api/notifications/:id/retry, owner only
viaSocket integration
viaSocket carries every message that leaves the app: Slack posts, emails, the Google Sheet log and the reminders. The app never talks to Slack or Gmail directly. Instead, the server sends a JSON event to a viaSocket flow with a webhook trigger, and the flow does the rest.
Five flows, built in two stages.
Flow
Trigger
What it does
Stage
ledger_commit
Webhook, fired when a day is committed
Posts the plan to Slack and emails it to the boss
1
ledger_daily_report
Webhook, fired when a day is closed
Posts the scorecard with proof links to Slack, emails it to the boss, and adds a row to a Google Sheet
1
ledger_review
Webhook, fired when a reviewer saves
Tells the owner on Slack and by email what was confirmed and any note
1
ledger_reminders
Schedule, weekdays at 10:30 and 18:30
Reads /api/status from the app; if there is no plan, or the day is not closed, it reminds the owner on Slack and by email
2
ledger_weekly_digest
Schedule, Fridays at 17:30
Reads the weekly report from the app and sends it to the boss
2
The Google Sheet is an outside, timestamped copy of each closed day (date, committed points, delivered points, promises kept, highlight). The boss can check the app's numbers against a record the app does not control.
Event payload. The server sends one JSON body per event. event_id is unique per type and date, so a repeat can be ignored.
{
  "token": "<VIASOCKET_SHARED_TOKEN>",
  "event_id": "daily_report:2026-11-07",
  "type": "daily_report",
  "date": "2026-11-07",
  "owner_name": "<owner name>",
  "committed_points": 14,
  "delivered_points": 9,
  "promises_kept_pct": 57,
  "outcomes": [
    {
      "title": "<outcome title>",
      "level": 8,
      "planned": true,
      "status": "done",
      "result": "<what changed>",
      "proof_url": "https://example.com/proof"
    }
  ],
  "highlight": "<most valuable thing delivered>",
  "learning": "<optional>",
  "report_url": "https://<app-domain>/report?week=2026-11-02"
}
How to build the flows with the viaSocket connector. Claude Code must load the viaSocket quickstart tool first and follow it, because the endpoints change.
1. Find each app with search_apps (Slack, Gmail, Google Sheets), then read its actions with list_app_actions (for example Slack send message, Gmail send email, Google Sheets add row).
2. Read list_connections and pick the auth_id that matches each app. Several Slack workspaces, Gmail accounts and sheets are connected, so ask the owner which to use. If an app is missing, create a sign-in link with create_connection_link and wait until the owner has signed in.
3. Summarize the plan for each flow and get the owner's yes. Then Create Empty Flow once per flow and keep its script_id. Never make a second flow for the same job.
4. Save the trigger: webhook for the three event flows, cron with a cronStatement for the two scheduled flows.
5. For each action, call Build Action Input with a plain-words instruction that carries the field mapping, then Save Steps with the full steps array. Save Steps replaces every step, so read the flow first and always send all steps.
6. The webhook URL is https://flow.sokt.io/func/<script_id>. Put it in the matching VIASOCKET_HOOK_* variable.
Step code rules in viaSocket. Name steps in lowercase with underscores. Read earlier steps by full path, such as context?.res?.step_name?.field. Use if guards, not try/catch. Use no imports or packages, and stay under 58 seconds. Add markdown console.log lines for the run history, and end every step with a return.
Every event flow starts with a guard step that compares token with the shared secret and returns early if it does not match. Never run a real action (run_app_action) while building; use it only for a one-off the owner asks for.
Reliability. The app writes the notification row in the same transaction as the change, then sends after the commit, so a viaSocket outage never blocks the owner. On failure it retries after 1, 5 and 30 minutes, then marks the row failed, and Settings shows the error with a Retry button.
Security. Webhook URLs and tokens live only in server environment variables and are never sent to the browser. Do not put passwords or session data in a payload.
Build order
Build in six phases, in order, and do not start a phase until the checks of the one before it pass. The owner should be able to use the app for real from the end of phase 2.
Phase 0: Setup
[ ] Project created, database migrated, seed script creates the owner and one reviewer
[ ] Sign in works for both roles, and a reviewer gets 403 on every owner write
Phase 1: Core ledger (owner)
[ ] lib/scoring.ts implements every definition and measure above, with unit tests including edge cases (no commitments, nothing reviewed, confirmed above claimed)
[ ] My day: add up to three outcomes, commit, close each as done, missed or carried, log unplanned work, close the day
[ ] Server rejects a fourth outcome, an edit after the lock, a done without proof, and a day close with an open outcome
[ ] Every state change appears in the audit log
Phase 2: Report and review
[ ] Report shows headline, circles, six measures, eight-week bars and day-by-day log
[ ] Reviewer confirms points and adds a note; claim accuracy and the green rings update
[ ] The ten-second test passes on a phone-sized screen
[ ] Copy-report text for a day and a week works
Phase 3: viaSocket event flows
[ ] Slack, Gmail and Google Sheets connections chosen with the owner
[ ] Flows ledger_commit, ledger_daily_report and ledger_review built, each guarded by the shared token
[ ] One test event per flow, sent only after the owner approves, arrives in Slack and email, and the sheet row appears
[ ] A failed send is retried and then shown in Settings with a Retry button
Phase 4: Reminders and weekly digest
[ ] /api/status and the weekly report endpoint are protected by REMINDER_TOKEN
[ ] ledger_reminders and ledger_weekly_digest run on schedule in the right timezone
[ ] A day with no plan produces a 10:30 reminder, and an unclosed day produces an 18:30 reminder
Phase 5: Deploy and daily use
[ ] Deployed through Embarko, environment variables set, owner and boss can sign in on the live URL
[ ] Owner uses it every working day for one week
[ ] End-of-week check with the boss: did the numbers match how the days felt? Adjust level descriptions, the commit hour or the measures if not
Open details to confirm
Claude Code should ask the owner these before the phase that needs them, and must not guess any of them. Tick each one once it is settled.
[ ] Which Slack workspace and channel should receive the plan and the daily report? (needed in phase 3)
[ ] Which Gmail account sends the emails, and what is the boss's email address? (phase 3)
[ ] Which Google Sheet and tab holds the outside log? (phase 3)
[ ] Can viaSocket step code call the app's /api/status URL with a fetch, or must the reminder flows use viaSocket's own HTTP or API action? Check the step-code docs before building flow 4. (phase 4)
[ ] Which timezone does viaSocket use for cron schedules? Confirm that 10:30 and 18:30 mean India time. (phase 4)
[ ] Who sets the weekly goals: only the owner, or the boss as well? The plan assumes both can. (phase 1)
[ ] Should the three-outcome daily limit and the 11:00 commit hour stay as defaults? Both are single settings. (phase 1)
[ ] Where will the app be hosted, and is Embarko the right target? (phase 5)
[ ] Is a shared password per role enough for sign-in, or should it use viaSocket login? The plan assumes passwords. (phase 0)