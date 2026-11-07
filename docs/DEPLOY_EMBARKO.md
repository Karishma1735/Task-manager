# Deploying Value Ledger on Embarko (private)

Audit date: 7 Nov 2026. Based on <https://embarko.ai/docs/quickstart.md> and the deploy, data, env-vars, lock, schedules and
embarko-json topics. **Nothing has been uploaded or deployed.**

## How the app maps to Embarko's rules

| Embarko rule | Value Ledger |
|---|---|
| Reads `PORT`, binds `0.0.0.0` | `next start` does both (verified: it listened on the network address on the port given). |
| One process, 256 MB | One Node process. `start` caps the heap (see "Memory"). |
| Persistent data only under `DATA_DIR` | In production the database is **always** `<DATA_DIR>/value-ledger.db` (+ `-wal`, `-shm`). The app refuses to start without `DATA_DIR`. Nothing is written next to the code (tested). |
| `DATA_DIR` starts empty; never overwrite on startup | Startup runs the committed migrations (idempotent) and creates the first accounts only if missing. It never resets passwords or touches existing rows (tested). |
| Leave `_litestream_seq` / `_litestream_lock` alone | Migrations are committed files applied by the Drizzle migrator, not a schema diff. Tested with both tables present. |
| No timer libraries / workers | None. A plain `setInterval` retries failed webhook deliveries; its state lives in the database. |
| No WebSockets | None. |
| Secrets in env vars, not in the upload | `.env*` and databases are excluded by `scripts/package-for-embarko.sh`. |
| Install deps → build → `npm start` | Build tooling is in `dependencies`; verified with a production-only install (`npm ci` with `NODE_ENV=production`) followed by `next build` in a clean copy. |
| No Dockerfile | None. |
| App Lock for private apps | `embarko.json` has `"lock": true`. |

## Memory (hard limit 256 MB)

Measured on a clean production-only install, under load (SSR pages + API, then ~1,900 requests incl. writes):

| Setting | Server peak | + `npm start` wrapper (~60 MB) | Result |
|---|---|---|---|
| none | ~234 MB | ~295 MB | over the limit |
| `--max-old-space-size=64` | ~184 MB | ~244 MB | stable, thin margin |
| `--max-old-space-size=64 --max-semi-space-size=1` | ~176 MB | ~234 MB | stable |
| **`--max-old-space-size=56 --max-semi-space-size=1`** (chosen) | **~166 MB** | **~226 MB** | stable, ~30 MB headroom |
| `--max-old-space-size=48 --max-semi-space-size=1` | ~156 MB | ~217 MB | stable, but close to the crash size |
| `--max-old-space-size=32 --max-semi-space-size=1` | crashed (out of memory) | – | too small |

The `start` script sets the chosen cap (see `package.json`). If Embarko does not count the `npm` wrapper, the real margin is larger.
Measured on this sandbox's CPU/OS: Embarko's own accounting is unverified until the first deploy — check the app's memory after it is live.

## Required secrets (Embarko "App setup")

| Variable | Notes |
|---|---|
| `SESSION_SECRET` | ≥ 32 random chars (`openssl rand -hex 32`). The app refuses to start otherwise. |
| `OWNER_EMAIL`, `OWNER_PASSWORD`, `OWNER_NAME` | Creates the owner on first start only. Password ≥ 12 chars. |
| `REVIEWER_EMAIL`, `REVIEWER_PASSWORD`, `REVIEWER_NAME` | Creates the reviewer on first start only. |
| `APP_BASE_URL` | `https://<app-name>.embarko.app` — lets same-origin (CSRF) checks pass behind Embarko's proxy; used in report links. |

Optional / later (Phase 3–4): `VIASOCKET_HOOK_COMMIT`, `VIASOCKET_HOOK_REPORT`, `VIASOCKET_HOOK_REVIEW`, `VIASOCKET_SHARED_TOKEN`,
`REMINDER_TOKEN`, `SCHEDULED_REMINDERS_ENABLED` (**leave unset/`0`** until destinations are approved).
Never set: `PORT`, `DATA_DIR`, `APP_NAME` (Embarko owns them), `VL_TEST_NOW`, `VL_ALLOW_TEST_CLOCK`, `VL_E2E_ALLOW`, `VIASOCKET_ALLOW_ANY_HOST` (the app refuses to start).

## Health and startup

- Health: `GET /api/health` → `{"status":"ok"}` (200) or `{"status":"unavailable"}` (503). Public; reveals nothing else.
- Start: `npm start`. On boot it validates configuration, migrates, seeds missing accounts and logs `[startup] database ready; …` (no emails or passwords).

## Deployment steps (after approval)

1. `scripts/package-for-embarko.sh` → clean `.tar.gz` (local only). The source is ~130 KB compressed but larger than 150 KB uncompressed with the lockfile, so use the HTTP tarball route or the chunked upload, not a single `deploy_app` call.
2. Deploy as a **kept** app (via the Embarko connector, or claim it) so that `"lock": true` applies — a temporary app ignores the lock and is deleted after 24 h.
3. Set the secrets above, then redeploy/apply.
4. Poll status until `live`; open the app **in a private window** and confirm it shows Embarko's lock page, not the app.
5. Sign in as the owner; add and commit a plan; confirm it survives a redeploy (data persists), and `/api/health` is ok.
6. Save `app.id` as `appId` in `embarko.json` for later redeploys.

## Needs manual configuration / decisions

- **Lock access**: App Lock admits members of the Embarko workspace, or anyone with the dashboard password (set only by a person). Decide how the reviewer (the boss) gets in.
- **viaSocket flows do not exist yet** (Phase 3 event flows and Phase 4 scheduled flows). A locked app **blocks inbound calls from other services**, so viaSocket's scheduled flows cannot read `/api/status` or `/api/report` while the app is locked. See the report for options.
- **No backups**: Embarko does not back up `DATA_DIR`. Export or accept the risk.
- **Passwords**: there is no password-change screen; changing `OWNER_PASSWORD` later does *not* change an existing account (by design, so startup can never overwrite data).
- **First-build risk**: `better-sqlite3` is a native module; the first Embarko build log must be checked.
