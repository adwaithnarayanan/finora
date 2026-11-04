import { type Page, expect, test } from "@playwright/test";

import { e2eUsers } from "./support/fixtures";
import { signInAs } from "./support/session";

const users = e2eUsers();

async function signIn(
  page: Page,
  email: string,
  password: string,
  path = "/login",
) {
  await page.goto(path);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

const formAlert = (page: Page) => page.locator("form").getByRole("alert");

const homeHeading = (page: Page) =>
  page.getByRole("heading", {
    level: 1,
    name: /know exactly where your money is/i,
  });

const authCookies = async (page: Page) =>
  (await page.context().cookies()).filter((c) =>
    /-auth-token(\.\d+)?$/.test(c.name),
  );

const GENERIC = "Invalid email or password.";

test.describe.configure({ mode: "serial" });

test.describe("unauthenticated access", () => {
  test("protected routes redirect to sign-in", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
    await page.goto("/reports?month=2026-10");
    await expect(page).toHaveURL(/\/login\?next=%2Freports%3Fmonth%3D2026-10$/);
  });

  test("protected HTML is never served to signed-out visitors", async ({
    request,
  }) => {
    const response = await request.get("/", { maxRedirects: 0 });
    expect(response.status()).toBe(307);
    expect(response.headers()["location"]).toMatch(/\/login$/);
    expect(await response.text()).not.toContain(
      "Know exactly where your money is",
    );
  });
});

test.describe("sign-in page", () => {
  test("offers email and password only: no Google, recovery or sign-up controls", async ({
    page,
  }) => {
    await page.goto("/login");
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute(
      "type",
      "password",
    );
    await expect(page.getByRole("button", { name: /google/i })).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: /forgot|reset|sign up|register/i }),
    ).toHaveCount(0);
  });
});

test.describe("password sign-in", () => {
  test("wrong password, unknown email and unverified email get the same generic error", async ({
    page,
  }) => {
    for (const [email, password] of [
      [users.owner.email, "Wrong-password-123"],
      ["nobody@finora.test", "Wrong-password-123"],
      [users.unverified.email, users.unverified.password],
      ["not-an-email", "x"],
    ] as const) {
      await signIn(page, email, password);
      await expect(formAlert(page), email).toHaveText(GENERIC);
      await expect(page).toHaveURL(/\/login/);
      expect(await authCookies(page)).toEqual([]);
    }
  });

  test("the sign-in button shows a pending state and a double submit sends one request", async ({
    page,
  }) => {
    let submissions = 0;
    await page.route("**/login*", async (route) => {
      const request = route.request();
      if (request.method() === "POST" && request.headers()["next-action"]) {
        submissions += 1;
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      await route.continue();
    });

    await page.goto("/login");
    await page.getByLabel("Email").fill(users.owner.email);
    await page
      .getByLabel("Password", { exact: true })
      .fill(users.owner.password);
    await page.getByRole("button", { name: "Sign in" }).click();

    const pending = page.getByRole("button", { name: "Signing in…" });
    await expect(pending).toBeDisabled();
    await pending.click({ force: true });
    await page.getByLabel("Password", { exact: true }).press("Enter");

    await expect(page).toHaveURL(/\/$/);
    expect(submissions).toBe(1);
    await page.getByRole("button", { name: "Sign out" }).click();
  });

  test("the owner signs in, sees the app, and signs out", async ({
    page,
    context,
  }) => {
    await signIn(page, users.owner.email, users.owner.password);
    await expect(page).toHaveURL(/\/$/);
    await expect(homeHeading(page)).toBeVisible();

    const sessionCookies = await authCookies(page);
    expect(sessionCookies.length).toBeGreaterThan(0);

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);

    await context.addCookies(sessionCookies);
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
    await expect(homeHeading(page)).toHaveCount(0);
  });

  test("a same-origin next path is honoured", async ({ page }) => {
    await signIn(
      page,
      users.owner.email,
      users.owner.password,
      "/login?next=%2F%3Ffrom%3Dlink",
    );
    await expect(page).toHaveURL(/\/\?from=link$/);
    await page.getByRole("button", { name: "Sign out" }).click();
  });

  for (const next of [
    "//evil.example/phish",
    "https://evil.example/",
    "/\\evil.example",
  ]) {
    test(`an off-site next (${next}) is ignored`, async ({ page }) => {
      await signIn(
        page,
        users.owner.email,
        users.owner.password,
        `/login?next=${encodeURIComponent(next)}`,
      );
      await expect(page).toHaveURL(/^http:\/\/localhost:\d+\/$/);
      await page.getByRole("button", { name: "Sign out" }).click();
    });
  }
});

test.describe("authenticated but not authorised", () => {
  for (const [label, key] of [
    ["a confirmed user who was never provisioned", "stranger"],
    ["an approved user with no owner mapping", "unmapped"],
    ["an inactive (disabled) owner", "inactive"],
  ] as const) {
    test(`${label} is refused and signed out`, async ({ page }) => {
      await signIn(page, users[key].email, users[key].password);
      await expect(page).toHaveURL(/\/unauthorized$/);
      await expect(
        page.getByRole("heading", { name: "No access" }),
      ).toBeVisible();
      expect(await authCookies(page)).toEqual([]);
      await page.goto("/");
      await expect(page).toHaveURL(/\/login$/);
    });
  }
});

test.describe("other sign-in methods cannot get in", () => {
  test("the owner's account is refused with a session that was not a password login", async ({
    page,
    context,
    baseURL,
  }) => {
    for (const method of ["otp", "oauth"] as const) {
      await context.clearCookies();
      await signInAs(context, baseURL!, users.owner.email, method);
      await page.goto("/");
      await expect(page, method).toHaveURL(/\/login$/);
      await expect(homeHeading(page)).toHaveCount(0);
    }
  });

  test("the deferred OAuth callback does nothing (404) and sets no session", async ({
    page,
    context,
  }) => {
    await context.clearCookies();
    for (const query of [
      "?code=00000000-0000-4000-8000-000000000000",
      "?error=access_denied&error_code=signup_disabled",
      "",
    ]) {
      const response = await page.goto(`/auth/callback${query}`);
      expect(response?.status(), query || "no query").toBe(404);
    }
    expect(await authCookies(page)).toEqual([]);
  });

  test("removed recovery and email-link routes are gone", async ({ page }) => {
    await signIn(page, users.owner.email, users.owner.password);
    await expect(homeHeading(page)).toBeVisible();
    for (const path of [
      "/forgot-password",
      "/reset-password",
      "/auth/confirm?token_hash=x&type=recovery",
    ]) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(404);
    }
    await page.goto("/");
    await page.getByRole("button", { name: "Sign out" }).click();
  });
});
