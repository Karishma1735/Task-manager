# Value Ledger

Measures the value of work delivered, not the number of tasks. Phases 0 and 1 of [docs/SPEC.md](docs/SPEC.md):
foundation, authentication, scoring engine, owner API and the **My Day** screen.
Private project — no deployment, email, Slack or viaSocket integration exists yet.

## Run locally

```bash
npm install
cp .env.example .env.local        # then fill in SESSION_SECRET and the owner/reviewer credentials
npm run db:setup                  # migrate + seed (idempotent)
npm run dev                       # http://localhost:3000
```

Generate secrets with `openssl rand -hex 32` (SESSION_SECRET) and `openssl rand -base64 18` (passwords, min 12 chars).
`SEED_RESET_PASSWORDS=1 npm run db:seed` rotates existing accounts' passwords.

## Checks

```bash
npm run lint && npm run typecheck && npm test && npm run build
npm run test:e2e                  # builds, starts on :3100 with a throwaway DB and a pinned server clock
```

## Layout

- `src/lib/scoring.ts` — pure scoring engine (no I/O). `tests/scoring.test.ts`
- `src/lib/ledger.ts` — all owner/goal rules, one transaction + audit entry per mutation
- `src/lib/auth.ts`, `src/lib/api.ts` — sessions, roles, same-origin (CSRF) guard, error mapping
- `src/db/schema.ts`, `drizzle/` — tables and migrations (audit-log and lock triggers live in `0001`)
- `src/app/api/**` — thin route handlers; `src/app/my-day` — the owner screen

## API (Phase 1)

| Route | Who | Notes |
|---|---|---|
| `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me` | all | HttpOnly SameSite=Lax cookie; Secure in production |
| `GET /api/my-day?date=` | owner | today or tomorrow |
| `POST /api/days/:date/outcomes` | owner | max 3 per day, today/tomorrow only |
| `PATCH` / `DELETE /api/outcomes/:id` | owner | drafts only (extra to spec: needed to edit a draft plan) |
| `POST /api/days/:date/commit` | owner | server time, locks plan, exclusive 11:00 deadline |
| `POST /api/outcomes/:id/close` | owner | `done` (proof+result), `missed`/`carried` (reason) |
| `POST /api/days/:date/unplanned` | owner | today only |
| `POST /api/days/:date/close` | owner | only when nothing is open |
| `GET /api/goals`, `GET`/`PUT /api/goals/:weekStart` | owner + reviewer | up to 3 goals; audited with actor |

Errors: 400 malformed · 401 unauthenticated · 403 role/CSRF · 404 · 409 state conflict · 422 validation/rule · 429 rate limit.

## Decisions on points the spec leaves open

- **No late commit.** After 11:00 (exclusive) the commit is refused (409). Nothing is backdated. Planning tomorrow is always possible today.
- **Carry with no room tomorrow** (locked or already three): the outcome is still closed as carried (scores 0), nothing is created, and the owner is told.
- **Rhythm** = (days committed by the deadline + days closed the same day) ÷ (2 × committed days).
- **High-leverage share** uses effective points (a reviewer lowering an 8 to 1 removes it from the share).
- **Goals**: owner and reviewers can edit (spec's stated assumption), for the current or next week; a goal that outcomes use cannot be removed.
- Unplanned work has no "done means"; it is stored `planned = false`, status `done`.
