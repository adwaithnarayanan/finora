import { type Page, expect, test } from "@playwright/test";

import { confirmLink, countEmails, latestEmailHtml } from "./support/mailpit";
import { e2eUsers } from "./support/fixtures";

const users = e2eUsers();

async function signIn(page: Page, email: string, password: string, path = "/login") {
  await page.goto(path);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** The form's own message (Next.js also renders an empty route-announcer alert). */
const formAlert = (page: Page) => page.locator("form").getByRole("alert");

const homeHeading = (page: Page) =>
  page.getByRole("heading", { level: 1, name: /know exactly where your money is/i });

test.describe.configure({ mode: "serial" });

test.describe("unauthenticated access", () => {
  test("protected routes redirect to sign-in", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
    await page.goto("/reports?month=2026-10");
    await expect(page).toHaveURL(/\/login\?next=%2Freports%3Fmonth%3D2026-10$/);
  });

  test("protected HTML is never served to signed-out visitors", async ({ request }) => {
    const response = await request.get("/", { maxRedirects: 0 });
    expect(response.status()).toBe(307);
    expect(response.headers()["location"]).toMatch(/\/login$/);
    expect(await response.text()).not.toContain("Know exactly where your money is");
  });
});

test.describe("sign-in", () => {
  test("wrong password and unknown email get the same generic error", async ({ page }) => {
    await signIn(page, users.owner.email, "Wrong-password-123");
    await expect(formAlert(page)).toHaveText("Invalid email or password.");
    await signIn(page, "nobody@finora.test", "Wrong-password-123");
    await expect(formAlert(page)).toHaveText("Invalid email or password.");
    await expect(page).toHaveURL(/\/login/);
  });

  test("a verified user who is not the owner is refused and signed out", async ({ page }) => {
    await signIn(page, users.stranger.email, users.stranger.password);
    await expect(page).toHaveURL(/\/unauthorized$/);
    await expect(page.getByRole("heading", { name: "No access" })).toBeVisible();
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("the owner signs in, sees the app, and signs out", async ({ page }) => {
    await signIn(page, users.owner.email, users.owner.password);
    await expect(page).toHaveURL(/\/$/);
    await expect(homeHeading(page)).toBeVisible();

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("a same-origin next path is honoured", async ({ page }) => {
    await signIn(page, users.owner.email, users.owner.password, "/login?next=%2F%3Ffrom%3Dlink");
    await expect(page).toHaveURL(/\/\?from=link$/);
    await page.getByRole("button", { name: "Sign out" }).click();
  });

  for (const next of ["//evil.example/phish", "https://evil.example/", "/\\evil.example"]) {
    test(`an off-site next (${next}) is ignored`, async ({ page }) => {
      await signIn(page, users.owner.email, users.owner.password, `/login?next=${encodeURIComponent(next)}`);
      await expect(page).toHaveURL(/^http:\/\/localhost:\d+\/$/);
      await page.getByRole("button", { name: "Sign out" }).click();
    });
  }
});

test.describe("password recovery", () => {
  test("the response does not reveal whether an address is registered", async ({ page }) => {
    const unknown = `nobody-${Date.now()}@finora.test`;
    const messages: string[] = [];
    for (const email of [users.owner.email, unknown]) {
      await page.goto("/forgot-password");
      await page.getByLabel("Email").fill(email);
      await page.getByRole("button", { name: "Send reset link" }).click();
      const status = page.getByRole("status");
      await expect(status).toBeVisible();
      messages.push((await status.textContent()) ?? "");
    }
    expect(messages[0]).toBe(messages[1]);
    expect(await countEmails(unknown)).toBe(0);
  });

  test("the owner resets the password through the emailed link", async ({ page, baseURL }) => {
    const requestedAt = new Date(Date.now() - 1000);
    await page.goto("/forgot-password");
    await page.getByLabel("Email").fill(users.owner.email);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByRole("status")).toBeVisible();

    const link = confirmLink(await latestEmailHtml(users.owner.email, requestedAt), baseURL!);

    // Opening the link (as a mail scanner would) must not spend the token.
    await page.goto(link);
    await page.goto(link);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page).toHaveURL(/\/reset-password$/);

    await page.getByLabel("New password", { exact: true }).fill("short");
    await page.getByLabel("Confirm new password").fill("short");
    await page.getByRole("button", { name: "Save password" }).click();
    await expect(formAlert(page)).toContainText("at least 12");

    const newPassword = `Reset-${Date.now()}-Aa1`;
    await page.getByLabel("New password", { exact: true }).fill(newPassword);
    await page.getByLabel("Confirm new password").fill(newPassword);
    await page.getByRole("button", { name: "Save password" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(homeHeading(page)).toBeVisible();
    await page.getByRole("button", { name: "Sign out" }).click();

    // The link is single-use.
    await page.goto(link);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page).toHaveURL(/\/login\?error=link$/);
    await expect(formAlert(page)).toContainText("invalid or has expired");

    // Old password no longer works; the new one does.
    await signIn(page, users.owner.email, users.owner.password);
    await expect(formAlert(page)).toHaveText("Invalid email or password.");
    await signIn(page, users.owner.email, newPassword);
    await expect(homeHeading(page)).toBeVisible();
    await page.getByRole("button", { name: "Sign out" }).click();
  });

  test("the reset form refuses visitors without a recovery session", async ({ page }) => {
    await page.goto("/reset-password");
    const password = `Nope-${Date.now()}-Aa1`;
    await page.getByLabel("New password", { exact: true }).fill(password);
    await page.getByLabel("Confirm new password").fill(password);
    await page.getByRole("button", { name: "Save password" }).click();
    await expect(page).toHaveURL(/\/forgot-password$/);
  });

  test("a tampered link is rejected", async ({ page }) => {
    await page.goto("/auth/confirm?token_hash=forged&type=recovery&next=/reset-password");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page).toHaveURL(/\/login\?error=link$/);
  });
});
