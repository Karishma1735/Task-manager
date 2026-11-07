/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Runs after 01/02 against the same throwaway database. Webhooks point at a local mock
 * (e2e/mock-webhook.mjs) — nothing here reaches viaSocket, Slack, Gmail or Google Sheets.
 */
const OWNER = { email: process.env.E2E_OWNER_EMAIL!, password: process.env.E2E_OWNER_PASSWORD! };
const REVIEWER = { email: process.env.E2E_REVIEWER_EMAIL!, password: process.env.E2E_REVIEWER_PASSWORD! };
const MOCK = "http://localhost:3101";

test.describe.configure({ mode: "serial" });

type Received = { hook: string; tokenOk: boolean; failed: boolean; body: Record<string, any> };
const log = async (request: APIRequestContext): Promise<Received[]> => (await request.get(`${MOCK}/__log`)).json();
const setFailing = (request: APIRequestContext, fail: boolean) => request.post(`${MOCK}/__mode`, { data: { fail } });

async function signIn(page: Page, who: { email: string; password: string }, landing: RegExp) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(who.email);
  await page.getByLabel("Password").fill(who.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(landing);
}

test("business actions from the earlier specs produced exactly the right events, once each", async ({ request }) => {
  await expect.poll(async () => (await log(request)).filter((r) => !r.failed).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(5);
  const ok = (await log(request)).filter((r) => !r.failed);
  expect(ok.every((r) => r.tokenOk)).toBe(true);
  const ids = ok.map((r) => r.body.event_id as string);
  expect(new Set(ids).size).toBe(ids.length); // nothing delivered twice
  expect(ids.filter((i) => i === "commit:2026-11-09")).toHaveLength(1);
  expect(ids.filter((i) => i === "daily_report:2026-11-09")).toHaveLength(1);
  expect(ids.filter((i) => i.startsWith("review:2026-11-09:")).length).toBeGreaterThanOrEqual(3); // 2 scores + 1 note

  const commit = ok.find((r) => r.hook === "commit")!;
  expect(commit.body).toMatchObject({ type: "commit", date: "2026-11-09", committed_points: 9 });
  expect(commit.body.outcomes.map((o: any) => o.level)).toEqual([8, 1]);

  const report = ok.find((r) => r.hook === "daily_report")!;
  expect(report.body).toMatchObject({
    type: "daily_report",
    committed_points: 9,
    delivered_points: 12,
    promises_kept_pct: 89,
    highlight: "The plug is live for customers.",
    learning: "Ship the small version first.",
  });
  expect(report.body.outcomes.find((o: any) => o.title === "Publish the plug").proof_url).toBe("https://example.com/plug/published");
  expect(report.body.is_test).toBeUndefined();

  const reviews = ok.filter((r) => r.hook === "review");
  const scored = reviews.find((r) => r.body.change === "score" && r.body.changed_outcome?.title === "Publish the plug")!;
  expect(scored.body.changed_outcome).toMatchObject({ claimed_points: 8, confirmed_points: 4 });
  expect(reviews.some((r) => r.body.change === "note" && r.body.reviewer_notes.length === 1)).toBe(true);
});

test("Settings shows health and the delivery log without revealing URLs or tokens", async ({ page }) => {
  await signIn(page, OWNER, /\/my-day/);
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings/);
  for (const t of ["commit", "daily_report", "review"]) await expect(page.getByTestId(`hook-${t}`)).toContainText("Configured");
  const sent = page.locator('[data-testid="notification"][data-status="sent"]');
  await expect(sent.first()).toBeVisible();
  await expect(page.locator('[data-testid="notification"][data-status="failed"]')).toHaveCount(0);
  const text = await page.locator("main").innerText();
  const html = await page.content();
  for (const secret of ["localhost:3101", process.env.E2E_HOOK_TOKEN!, "example.com/plug/published", "/hook/"]) {
    expect(text).not.toContain(secret);
    expect(html).not.toContain(secret);
  }
});

test("a failing flow is retried, shown as Failed in Settings, and recovers with Retry", async ({ page, request }) => {
  await signIn(page, OWNER, /\/my-day/);
  await page.goto("/settings");
  await setFailing(request, true);
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Test ledger_daily_report" }).click();

  const failed = page.locator('[data-testid="notification"][data-status="failed"][data-type="daily_report"]');
  await expect(failed).toHaveCount(1, { timeout: 15_000 });
  await expect(failed.getByTestId("notification-status")).toHaveText("Failed");
  await expect(failed.getByTestId("notification-error")).toHaveText("Last error: http_500");
  expect((await log(request)).filter((r) => r.failed && r.body.is_test)).toHaveLength(4); // 1 try + 3 retries

  await setFailing(request, false);
  await failed.getByRole("button", { name: "Retry" }).click();
  await expect(page.locator('[data-testid="notification"][data-status="failed"]')).toHaveCount(0, { timeout: 15_000 });
  const delivered = (await log(request)).filter((r) => !r.failed && r.body.is_test === true);
  expect(delivered).toHaveLength(1);
  expect(delivered[0]!.body.event_id).toMatch(/^test:daily_report:\d+$/);
  expect(delivered[0]!.body.outcomes[0].title).toMatch(/TEST EVENT/);
});

test("a reviewer cannot open Settings or read the notification log", async ({ page, baseURL }) => {
  await signIn(page, REVIEWER, /\/report/);
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/report/);
  expect((await page.request.get("/api/notifications")).status()).toBe(403);
  const retry = await page.request.post("/api/notifications/1/retry", { data: {}, headers: { origin: baseURL! } });
  expect(retry.status()).toBe(403);
  const test = await page.request.post("/api/notifications/test", { data: { type: "commit" }, headers: { origin: baseURL! } });
  expect(test.status()).toBe(403);
});
