import { expect, test } from "@playwright/test";

/**
 * Scheduled-flow endpoints, exercised over real HTTP against the production build with the clock pinned to
 * Monday 9 Nov 2026 09:30 IST. By now (after specs 01–03) Monday is committed and closed.
 * No viaSocket flow, Slack or email is involved.
 */
const TOKEN = process.env.E2E_REMINDER_TOKEN!;
const auth = { "x-reminder-token": TOKEN };

test.describe.configure({ mode: "serial" });

test("status requires the token header; wrong, missing or URL-borne tokens are refused", async ({ request }) => {
  expect((await request.get("/api/status?date=today")).status()).toBe(401);
  expect((await request.get("/api/status?date=today", { headers: { "x-reminder-token": "not-the-right-token-value" } })).status()).toBe(401);
  expect((await request.get(`/api/status?date=today&token=${TOKEN}`)).status()).toBe(400);
  expect((await request.get(`/api/status?date=today&token=${TOKEN}`, { headers: auth })).status()).toBe(400);
  expect((await request.get("/api/status?date=garbage", { headers: auth })).status()).toBe(400);

  const ok = await request.get("/api/status?date=today", { headers: auth });
  expect(ok.status()).toBe(200);
  const body = await ok.json();
  expect(body.data).toMatchObject({ date: "2026-11-09", weekday: "Mon", isWorkday: true, committed: true, closed: true, tz: "Asia/Kolkata" });
  expect(body.data.due).toEqual({ morning: false, evening: false });
  expect(JSON.stringify(body)).not.toContain(TOKEN);
  expect(JSON.stringify(body)).not.toMatch(/Publish the plug|example\.com/); // no work content
});

test("a signed-in session does not open the scheduled endpoints", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(process.env.E2E_OWNER_EMAIL!);
  await page.getByLabel("Password").fill(process.env.E2E_OWNER_PASSWORD!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/my-day/);
  expect((await page.request.get("/api/status?date=today")).status()).toBe(401);
});

test("claims send nothing when there is nothing to remind about, on any retry", async ({ request }) => {
  const claim = (kind: string) => request.post("/api/scheduled/claim", { data: { kind }, headers: auth });
  // Monday is already committed and closed: no morning reminder, no evening reminder.
  for (let i = 0; i < 2; i++) {
    expect((await (await claim("reminder_morning")).json()).data).toEqual({ send: false, reason: "already_committed" });
    expect((await (await claim("reminder_evening")).json()).data).toEqual({ send: false, reason: "already_closed" });
  }
  // The digest runs on Fridays only.
  expect((await (await claim("weekly_digest")).json()).data).toEqual({ send: false, reason: "not_friday" });
  expect((await request.post("/api/scheduled/claim", { data: { kind: "bogus" }, headers: auth })).status()).toBe(422);
  expect((await request.post("/api/scheduled/claim", { data: { kind: "reminder_morning" } })).status()).toBe(401);
  expect((await request.post("/api/scheduled/confirm", { data: { eventId: "reminder_morning:2026-11-09", ok: true }, headers: auth })).status()).toBe(404);
});

test("the report endpoint serves the scheduler token and returns a ready weekly digest", async ({ request }) => {
  expect((await request.get("/api/report?week=2026-11-09")).status()).toBe(401);
  const res = await request.get("/api/report?week=2026-11-09&digest=1", { headers: auth });
  expect(res.status()).toBe(200);
  const { data } = await res.json();
  expect(data.value).toEqual({ confirmed: 4, awaiting: 0, total: 4 });
  const text: string = data.digest.text;
  expect(data.digest.snapshot.isSnapshot).toBe(true); // Monday: the week is still in progress
  expect(text).toContain("SNAPSHOT as of 9:30 AM Asia/Kolkata — the week is still in progress.");
  expect(text).toContain("VALUE DELIVERED: 4 points — 4 confirmed plus 0 awaiting review");
  expect(text).toContain("Promises kept (weighted by points): 89%");
  expect(text).toContain("Claim accuracy: 33%");
  expect(text).toContain("Evidence: https://example.com/plug/published");
  expect(text).toContain("(missed): Ran out of time after the launch.");
  expect(text).not.toContain(TOKEN);
  expect((await request.get("/api/report?week=2026-11-10", { headers: auth })).status()).toBe(400);
});

test("Settings shows the scheduled-flow gate and token status without revealing the token", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(process.env.E2E_OWNER_EMAIL!);
  await page.getByLabel("Password").fill(process.env.E2E_OWNER_PASSWORD!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.goto("/settings");
  const health = page.getByTestId("scheduled-health");
  await expect(health).toContainText("Enabled");
  await expect(health).toContainText("Configured");
  expect(await page.content()).not.toContain(TOKEN);
});
