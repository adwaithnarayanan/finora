import { expect, test } from "@playwright/test";

test("sign-in page renders the Finora shell without layout overflow", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/login");
  await expect(page).toHaveTitle("Sign in · Finora");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, "no horizontal page scroll").toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

test("there is no public sign-up page", async ({ page }) => {
  for (const path of ["/signup", "/sign-up", "/register"]) {
    const response = await page.goto(path);
    // Signed-out visitors are sent to /login; the route itself does not exist.
    expect(page.url()).toContain("/login");
    expect(response?.status()).toBeLessThan(500);
  }
  await page.goto("/login");
  await expect(page.getByRole("link", { name: /sign up|register|create account/i })).toHaveCount(0);
});
