import { expect, test, type Page } from "@playwright/test";

/**
 * Runs after 01-ledger.spec.ts in the same throwaway database (serial, single worker):
 * Monday 9 Nov holds a closed day — plug (claimed 8, done), partner emails (claimed 1, missed),
 * and unplanned "Fix broken webhook" (claimed 4, done).
 */
const OWNER = { email: process.env.E2E_OWNER_EMAIL!, password: process.env.E2E_OWNER_PASSWORD! };
const REVIEWER = { email: process.env.E2E_REVIEWER_EMAIL!, password: process.env.E2E_REVIEWER_PASSWORD! };

test.use({ permissions: ["clipboard-read", "clipboard-write"] });
test.describe.configure({ mode: "serial" });

async function signIn(page: Page, who: { email: string; password: string }, landing: RegExp) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(who.email);
  await page.getByLabel("Password").fill(who.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(landing);
}

const outcome = (page: Page, title: string) => page.getByTestId("day-outcome").filter({ hasText: title });
const score = async (page: Page, title: string, points: number, button: RegExp) => {
  const o = outcome(page, title);
  await o.getByRole("radio", { name: String(points), exact: true }).check({ force: true });
  await o.getByRole("button", { name: button }).click();
  await expect(o.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
};

test("reviewer lands on the report and sees value before any review", async ({ page }) => {
  await signIn(page, REVIEWER, /\/report/);
  await expect(page.getByTestId("value-total")).toHaveText("12");
  await expect(page.getByTestId("value-split")).toHaveText("0 confirmed plus 12 awaiting review");
  await expect(page.getByTestId("review-status")).toHaveText("Awaiting review");
  await expect(page.getByTestId("promises-kept")).toHaveText("89%"); // 8 of 9 promised points
  await expect(page.getByTestId("measure-accuracy-value")).toHaveText("—"); // nothing reviewed: unavailable, not 100%
  const circles = page.getByTestId("value-circle");
  await expect(circles).toHaveCount(2);
  for (const c of await circles.all()) await expect(c).toHaveAttribute("data-state", "awaiting");
  // size equals worth: the 8-point circle is larger than the 4-point one
  const sizes = await circles.evaluateAll((els) => els.map((e) => ({ pts: Number(e.textContent), w: e.getBoundingClientRect().width })));
  const eight = sizes.find((s) => s.pts === 8)!;
  const four = sizes.find((s) => s.pts === 4)!;
  expect(eight.w).toBeGreaterThan(four.w);
});

test("reviewer reads the evidence, adjusts a score, and every number updates", async ({ page }) => {
  await signIn(page, REVIEWER, /\/report/);
  const plug = outcome(page, "Publish the plug");
  await expect(plug.getByText("Plug published with 10 actions")).toBeVisible(); // expected result
  await expect(plug.getByText("Published to the marketplace.")).toBeVisible(); // actual result
  const link = plug.getByRole("link", { name: "https://example.com/plug/published" });
  await expect(link).toHaveAttribute("href", "https://example.com/plug/published");
  await expect(link).toHaveAttribute("rel", /noopener/);

  await score(page, "Publish the plug", 4, /Confirm 4 points/); // 8 → 4
  await expect(plug.getByTestId("verification")).toHaveText("Confirmed by reviewer: 4 points (claimed 8)");
  await expect(page.getByTestId("value-split")).toHaveText("4 confirmed plus 4 awaiting review");
  await expect(page.getByTestId("review-status")).toHaveText("Partly reviewed");
  await expect(page.getByTestId("measure-accuracy-value")).toHaveText("50%");
  await expect(page.locator('[data-testid="value-circle"][data-state="confirmed"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="value-circle"][data-state="awaiting"]')).toHaveCount(1);

  // A reviewer score of zero draws a dashed empty circle and adds no value
  await score(page, "Fix broken webhook", 0, /Confirm 0 points/);
  await expect(page.getByTestId("value-split")).toHaveText("4 confirmed plus 0 awaiting review");
  await expect(page.getByTestId("review-status")).toHaveText("Reviewed");
  await expect(page.locator('[data-testid="value-circle"][data-state="zero"]')).toHaveCount(1);
  await expect(page.getByTestId("measure-accuracy-value")).toHaveText("33%"); // 4 ÷ (8 + 4)
  await expect(page.getByTestId("promises-kept")).toHaveText("89%"); // reviewers never change reliability
  await expect(page.getByTestId("measure-unplanned-value")).toHaveText("0%");

  // Feedback on the day
  await page.getByLabel("Your note on this day").fill("Strong launch day. Next time, aim the unplanned fix at the root cause.");
  await page.getByRole("button", { name: "Save note" }).click();
  await expect(page.getByText("Strong launch day.", { exact: false }).first()).toBeVisible();
});

test("eight-week chart shows this week's total and seven empty weeks", async ({ page }) => {
  await signIn(page, REVIEWER, /\/report/);
  const bars = page.getByTestId("week-bar");
  await expect(bars).toHaveCount(8);
  await expect(bars.last()).toHaveAttribute("data-total", "4");
  await expect(bars.first()).toHaveAttribute("data-total", "0");
  await page.getByText("View as table").click();
  await expect(page.getByRole("table")).toBeVisible();
});

test("the owner sees the reviewer's verdict but cannot change it", async ({ page, baseURL }) => {
  await signIn(page, OWNER, /\/my-day/);
  await expect(page.getByTestId("value-breakdown")).toHaveText("4 confirmed plus 0 awaiting review");
  await expect(page.getByText("Strong launch day.", { exact: false })).toBeVisible();
  await page.getByRole("link", { name: "Report" }).click();
  await expect(page).toHaveURL(/\/report/);
  await expect(page.getByTestId("review-status")).toHaveText("Reviewed");
  await expect(page.getByText("Strong launch day.", { exact: false }).first()).toBeVisible();
  // no scoring or note controls for the owner
  await expect(page.getByRole("group", { name: /Confirmed points/ })).toHaveCount(0);
  await expect(page.getByLabel("Your note on this day")).toHaveCount(0);
  // and the server refuses even a hand-made request
  const ids = await page.getByTestId("day-outcome").evaluateAll((els) => els.map((e) => e.id.replace("outcome-", "")));
  for (const id of ids) {
    const res = await page.request.put(`/api/reviews/${id}`, { data: { confirmedPoints: 8 }, headers: { origin: baseURL! } });
    expect(res.status()).toBe(403);
  }
  const note = await page.request.put("/api/day-notes/2026-11-09", { data: { note: "I rate myself" }, headers: { origin: baseURL! } });
  expect(note.status()).toBe(403);
  await expect(page.getByTestId("value-split")).toHaveText("4 confirmed plus 0 awaiting review");
});

test("copy this week's and today's report", async ({ page }) => {
  await signIn(page, OWNER, /\/my-day/);
  await page.getByRole("button", { name: "Copy today’s report" }).click();
  await expect(page.getByText("Copied to clipboard.")).toBeVisible();
  const day = await page.evaluate(() => navigator.clipboard.readText());
  expect(day).toContain("Day report");
  expect(day).toContain("Confirmed by reviewer: 4 points (claimed 8)");
  expect(day).toContain("Scored 0 by reviewer (claimed 4)");
  expect(day).toContain("Evidence: https://example.com/plug/published");
  expect(day).toContain("Actual: Published to the marketplace.");
  expect(day).toContain("Missed: Ran out of time after the launch.");

  await page.goto("/report");
  await page.getByRole("button", { name: "Copy this week’s report" }).click();
  await expect(page.getByText("Copied to clipboard.")).toBeVisible();
  const week = await page.evaluate(() => navigator.clipboard.readText());
  expect(week).toContain("Week report");
  expect(week).toContain("Value delivered: 4 points — 4 confirmed plus 0 awaiting review");
  expect(week).toContain("• Promises kept: 89%");
  expect(week).toContain("• Claim accuracy: 33%");
  expect(week).toContain("Evidence: https://example.com/incident/1");
  expect(week).toContain("Reviewer note (");
});

test("mobile: value, promises kept and review status are visible without scrolling, and nothing overflows", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true });
  const page = await ctx.newPage();
  await signIn(page, REVIEWER, /\/report/);
  for (const id of ["value-total", "value-split", "promises-kept", "review-status"]) {
    const box = await page.getByTestId(id).boundingBox();
    expect(box, id).not.toBeNull();
    expect(box!.y + box!.height, `${id} fits the first screen`).toBeLessThanOrEqual(844);
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const chart = await page.locator("figure svg").first().boundingBox();
  expect(chart!.x + chart!.width).toBeLessThanOrEqual(390);
  await ctx.close();
});

test("dark mode and keyboard focus are supported", async ({ page }) => {
  await signIn(page, REVIEWER, /\/report/);
  await page.emulateMedia({ colorScheme: "light" });
  const light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.emulateMedia({ colorScheme: "dark" });
  const dark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(dark).not.toBe(light);
  await page.emulateMedia({ colorScheme: "light" });
  // circles are keyboard reachable and show a visible focus ring
  const first = page.getByTestId("value-circle").first();
  await first.focus();
  await expect(first).toBeFocused();
  const outline = await first.evaluate((e) => getComputedStyle(e).outlineWidth);
  expect(parseFloat(outline)).toBeGreaterThanOrEqual(2);
});

test("user text on the report is escaped", async ({ page }) => {
  await signIn(page, OWNER, /\/my-day/);
  await page.goto("/report");
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  await expect(page.locator("main img")).toHaveCount(0);
});
