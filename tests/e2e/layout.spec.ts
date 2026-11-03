import { expect, test } from "@playwright/test";

test("sign-in page renders the Finora shell without layout overflow", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/login");
  await expect(page).toHaveTitle("Sign in · Finora");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();

  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow, "no horizontal page scroll").toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

test("there is no public sign-up page", async ({ page }) => {
  for (const path of ["/signup", "/sign-up", "/register"]) {
    const response = await page.goto(path);
    expect(page.url()).toContain("/login");
    expect(response?.status()).toBeLessThan(500);
  }
  await page.goto("/login");
  await expect(
    page.getByRole("link", { name: /sign up|register|create account/i }),
  ).toHaveCount(0);
});

test("owner pages fit the screen without horizontal scrolling", async ({
  page,
}) => {
  const { e2eUsers } = await import("./support/fixtures");
  const { signIn } = await import("./support/login");
  const { owner } = e2eUsers();
  await signIn(page, owner.email, owner.password);
  await expect(page).toHaveURL(/\/$/);
  for (const path of [
    "/accounts",
    "/accounts/new",
    "/transactions",
    "/transactions/new",
    "/categories",
  ]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
});
