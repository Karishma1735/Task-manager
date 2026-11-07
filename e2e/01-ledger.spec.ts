import { expect, test, type Page } from "@playwright/test";

const OWNER = { email: process.env.E2E_OWNER_EMAIL!, password: process.env.E2E_OWNER_PASSWORD! };
const REVIEWER = { email: process.env.E2E_REVIEWER_EMAIL!, password: process.env.E2E_REVIEWER_PASSWORD! };

async function signIn(page: Page, who: { email: string; password: string }, landing: RegExp) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(who.email);
  await page.getByLabel("Password").fill(who.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(landing);
}

async function addOutcome(page: Page, title: string, doneMeans: string, level: number) {
  const form = page.getByRole("form", { name: "Add outcome" });
  await form.getByLabel("Title").fill(title);
  await form.getByLabel("Done means…").fill(doneMeans);
  await form.getByRole("radio", { name: new RegExp(`^${level}\\b`) }).check({ force: true });
  await form.getByRole("button", { name: "Add outcome" }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test("unauthenticated visitors are sent to sign in", async ({ page }) => {
  await page.goto("/my-day");
  await expect(page).toHaveURL(/\/login/);
});

test("rejects a wrong password without revealing which part was wrong", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password").fill("definitely-not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert").getByText("don't match")).toBeVisible();
});

test("the full owner loop: login, plan, commit, close with proof, close the day", async ({ page }) => {
  // Owner login
  await signIn(page, OWNER, /\/my-day/);
  await expect(page.getByRole("heading", { name: "My day" })).toBeVisible();
  await expect(page.getByTestId("date-label")).toHaveText("Monday 9 November");

  // Weekly goal
  await page.getByRole("button", { name: "Set goals" }).click();
  await page.getByLabel("Goal 1").fill("Launch the Zoho Books plug");
  await page.getByLabel("Measured by").fill("Published with 10 actions");
  await page.getByRole("button", { name: "Save goals" }).click();
  await expect(page.getByText("Measured by: Published with 10 actions")).toBeVisible();

  // Create the daily plan
  await addOutcome(page, "Publish the plug", "Plug published with 10 actions", 8);
  await addOutcome(page, "Reply to partner emails", "Inbox answered", 1);
  await expect(page.getByTestId("outcome")).toHaveCount(2);

  // Commit locks the plan
  await page.getByRole("button", { name: "Commit plan" }).click();
  await expect(page.getByText(/locked/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Commit plan" })).toHaveCount(0);
  await expect(page.getByTestId("outcome").getByRole("button", { name: "Edit" })).toHaveCount(0);
  await expect(page.getByTestId("outcome").getByRole("button", { name: "Remove" })).toHaveCount(0);

  // Done without proof is blocked by the browser form and by the server
  const first = page.getByTestId("outcome").filter({ hasText: "Publish the plug" });
  await first.getByRole("button", { name: "Done", exact: true }).click();
  await first.getByLabel("What changed?").fill("Published to the marketplace.");
  await first.getByRole("button", { name: "Close as done" }).click(); // proof missing → native validation stops it
  await expect(first).toHaveAttribute("data-status", "open");
  await first.getByLabel("Proof link").fill("https://example.com/plug/published");
  await first.getByRole("button", { name: "Close as done" }).click();
  await expect(first).toHaveAttribute("data-status", "done");
  await expect(first.getByText("Awaiting review · 8 claimed")).toBeVisible();
  await expect(first.getByRole("link", { name: "https://example.com/plug/published" })).toBeVisible();

  // Day cannot be closed while an outcome is open
  await expect(page.getByRole("button", { name: "Close the day" })).toBeDisabled();

  // Missed needs a reason
  const second = page.getByTestId("outcome").filter({ hasText: "Reply to partner emails" });
  await second.getByRole("button", { name: "Missed" }).click();
  await second.getByLabel("Why was it missed?").fill("Ran out of time after the launch.");
  await second.getByRole("button", { name: "Close as missed" }).click();
  await expect(second).toHaveAttribute("data-status", "missed");

  // Unplanned work stays separate and does not touch promises kept
  await page.getByRole("button", { name: "Log unplanned work" }).click();
  const un = page.getByRole("form", { name: "Log unplanned work" });
  await un.getByLabel("Title").fill("Fix broken webhook");
  await un.getByRole("radio", { name: /^4\b/ }).check({ force: true });
  await un.getByLabel("Actual result").fill("Webhook delivering again.");
  await un.getByLabel("Proof link").fill("https://example.com/incident/1");
  await un.getByRole("button", { name: "Log unplanned work" }).click();
  await expect(page.getByText("Fix broken webhook")).toBeVisible();
  await expect(page.getByText("Unplanned", { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId("promises-kept")).toHaveText("89%"); // 8 of 9 promised points
  await expect(page.getByTestId("value-breakdown")).toHaveText("0 confirmed plus 12 awaiting review");

  // Close the day
  await page.getByLabel("Most valuable thing delivered today").fill("The plug is live for customers.");
  await page.getByLabel(/One thing learned/).fill("Ship the small version first.");
  await page.getByRole("button", { name: "Close the day" }).click();
  await expect(page.getByRole("heading", { name: "Day closed" })).toBeVisible();
  await expect(page.getByText("The plug is live for customers.")).toBeVisible();
});

test("user text is rendered escaped (no XSS)", async ({ page }) => {
  await signIn(page, OWNER, /\/my-day/);
  await page.getByRole("tab", { name: "Tomorrow" }).click();
  await addOutcome(page, `<img src=x onerror="window.__xss=1">`, `<script>window.__xss=1</script>`, 2);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  await expect(page.locator("main img")).toHaveCount(0);
});

test("a reviewer is forbidden from every owner mutation", async ({ page, baseURL }) => {
  await signIn(page, REVIEWER, /\/report/);
  // The owner screen is not reachable
  await page.goto("/my-day");
  await expect(page).toHaveURL(/\/report/);

  const headers = { origin: baseURL! };
  const attempts: Array<[string, string, unknown]> = [
    ["POST", "/api/days/2026-11-09/outcomes", { title: "x", doneMeans: "y", level: 4 }],
    ["POST", "/api/days/2026-11-10/commit", {}],
    ["POST", "/api/outcomes/1/close", { status: "missed", reason: "r" }],
    ["POST", "/api/days/2026-11-09/close", { highlight: "h" }],
    ["POST", "/api/days/2026-11-09/unplanned", { title: "x", level: 1, result: "r", proofUrl: "https://a.b" }],
  ];
  for (const [method, url, data] of attempts) {
    const res = await page.request.fetch(url, { method, data, headers });
    expect(res.status(), `${method} ${url}`).toBe(403);
  }
  // Reviewers may edit goals (spec assumption), but only with a same-origin request
  const goals = await page.request.put("/api/goals/2026-11-09", { data: { goals: [{ text: "Launch the Zoho Books plug", measure: "Published with 10 actions" }] }, headers });
  expect(goals.status()).toBe(200);
  const cross = await page.request.put("/api/goals/2026-11-09", { data: { goals: [] }, headers: { origin: "http://evil.example" } });
  expect(cross.status()).toBe(403);
});

test("anonymous API calls get 401", async ({ request, baseURL }) => {
  const res = await request.post("/api/days/2026-11-09/outcomes", { data: {}, headers: { origin: baseURL! } });
  expect(res.status()).toBe(401);
});
