import { expect, test } from "@playwright/test";

test("home page renders the Finora shell", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/");

  await expect(page).toHaveTitle("Finora");
  await expect(
    page.getByRole("heading", { level: 1, name: /know exactly where your money is/i }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: /design principles/i })).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, "no horizontal page scroll").toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});
