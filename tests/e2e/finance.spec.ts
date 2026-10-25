import { type Locator, type Page, expect, test } from "@playwright/test";

import pg from "pg";

import { readLocalSupabase } from "../../scripts/lib/local-supabase.mjs";

import { e2eUsers } from "./support/fixtures";
import { signIn } from "./support/login";

const users = e2eUsers();

test.describe.configure({ mode: "serial" });

/** Selects the option whose visible text contains `text` (labels include balances). */
async function choose(select: Locator, text: string) {
  const value = await select.locator("option", { hasText: text }).first().getAttribute("value");
  await select.selectOption(value!);
}

/** Counts the owner's categories directly in the LOCAL database. */
async function categoryCount(ownerId: string): Promise<number> {
  const db = new pg.Client({ connectionString: readLocalSupabase().migrationDatabaseUrl.replace(/\?.*$/, "") });
  await db.connect();
  try {
    return (await db.query("SELECT count(*)::int AS n FROM finora.categories WHERE owner_id = $1", [ownerId])).rows[0].n;
  } finally {
    await db.end();
  }
}

const balanceOn = (page: Page) => page.getByText("Posted balance").locator("xpath=following-sibling::p[1]");

async function openAccount(page: Page, name: string) {
  await page.goto("/accounts?archived=1"); // include archived accounts
  await page.getByRole("link", { name: new RegExp(`^${name}`) }).click();
  await expect(page.getByRole("heading", { level: 1, name: new RegExp(name) })).toBeVisible();
}

async function record(page: Page, fill: (page: Page) => Promise<void>) {
  await page.goto("/transactions/new");
  await fill(page);
  await page.getByRole("button", { name: /^Record / }).click();
  await expect(page).toHaveURL(/\/transactions\?recorded=/);
  await expect(page.getByRole("status").filter({ hasText: "Transaction recorded." })).toBeVisible();
}

test.describe("unauthorised access", () => {
  test("signed-out visitors are sent to sign-in from every finance page", async ({ page }) => {
    for (const path of ["/accounts", "/accounts/new", "/transactions", "/transactions/new", "/categories"]) {
      await page.goto(path);
      await expect(page, path).toHaveURL(/\/login/);
    }
  });

  test("a signed-in non-owner is refused and sees no finance pages", async ({ page }) => {
    await signIn(page, users.stranger.email, users.stranger.password, "/login?next=%2Faccounts");
    await expect(page).toHaveURL(/\/unauthorized$/);
    await page.goto("/accounts");
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("heading", { name: "Accounts" })).toHaveCount(0);
  });
});

test.describe("accounts and transactions (owner)", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, users.owner.email, users.owner.password);
    await expect(page).toHaveURL(/\/$/);
  });

  test("create a bank account with an opening balance, and a cash account", async ({ page }) => {
    await page.goto("/accounts");
    await expect(page.getByText("No accounts yet")).toBeVisible();
    await page.getByRole("link", { name: "Create your first account" }).click();

    await page.getByLabel("Account name").fill("HDFC Savings");
    await expect(page.getByLabel("Type")).toHaveValue("bank");
    await expect(page.getByLabel("Currency")).toHaveValue("INR");
    await expect(page.getByText(/not as income/)).toBeVisible();
    await page.getByLabel("Amount", { exact: true }).fill("50000");
    await page.getByLabel("As of").fill("2026-10-01");
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page.getByRole("heading", { level: 1, name: /HDFC Savings/ })).toBeVisible();
    await expect(balanceOn(page)).toHaveText("₹50,000.00");
    await expect(page.getByText("₹50,000.00 as of 1 Oct 2026")).toBeVisible();

    await page.goto("/accounts/new");
    await page.getByLabel("Account name").fill("Wallet");
    await page.getByLabel("Type").selectOption("cash");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(balanceOn(page)).toHaveText("₹0.00");
  });

  test("validation errors keep the input and save nothing", async ({ page }) => {
    await page.goto("/accounts/new");
    await page.getByLabel("Account name").fill("hdfc savings");
    await page.getByLabel("Amount", { exact: true }).fill("12.345");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText("Use at most 2 decimal places for INR")).toBeVisible();
    await expect(page.getByLabel("Account name")).toHaveValue("hdfc savings");
    await page.getByLabel("Amount", { exact: true }).fill("10");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.locator("form").getByRole("alert")).toHaveText("You already have an account with that name");
  });

  test("viewing pages creates no categories; defaults are added only on request", async ({ page }) => {
    const ownerId = users.owner.ownerId;
    expect(await categoryCount(ownerId)).toBe(0);
    await page.goto("/transactions/new");
    await expect(page.getByText(/no active income or expense categories/)).toBeVisible();
    await page.goto("/categories");
    await expect(page.getByText("No categories yet")).toBeVisible();
    await page.reload();
    expect(await categoryCount(ownerId)).toBe(0);

    await page.getByRole("button", { name: "Add default categories" }).click();
    await expect(page.getByRole("region", { name: "Income categories" })).toContainText("Salary");
    const created = await categoryCount(ownerId);
    expect(created).toBeGreaterThan(0);
    await page.goto("/transactions/new");
    await page.goto("/categories");
    expect(await categoryCount(ownerId)).toBe(created);
  });

  test("record income, an expense and a transfer", async ({ page }) => {
    await record(page, async (p) => {
      await p.getByLabel(/^Income/).check();
      await choose(p.getByLabel("Received into", { exact: true }), "HDFC Savings");
      await p.getByLabel("Category", { exact: true }).selectOption({ label: "Salary" });
      await p.getByLabel("Amount", { exact: true }).fill("25000.50");
      await p.getByLabel("Date", { exact: true }).fill("2026-10-20");
      await p.getByLabel("Received from (optional)").fill("Acme Ltd");
    });
    await record(page, async (p) => {
      await expect(p.getByLabel(/^Expense/)).toBeChecked();
      await choose(p.getByLabel("Paid from", { exact: true }), "HDFC Savings");
      await p.getByLabel("Category", { exact: true }).selectOption({ label: "Groceries" });
      await p.getByLabel("Amount", { exact: true }).fill("1200");
      await p.getByLabel("Date", { exact: true }).fill("2026-10-21");
      await p.getByLabel("Paid to (optional)").fill("BigBasket");
      await p.getByLabel("Note (optional)").fill("Weekly shop");
    });
    await record(page, async (p) => {
      await p.getByLabel(/^Transfer/).check();
      await choose(p.getByLabel("From account", { exact: true }), "HDFC Savings");
      await choose(p.getByLabel("To account", { exact: true }), "Wallet");
      await p.getByLabel("Amount", { exact: true }).fill("2000");
      await p.getByLabel("Date", { exact: true }).fill("2026-10-22");
    });
  });

  test("a transfer needs two different accounts and a valid amount", async ({ page }) => {
    await page.goto("/transactions/new?type=transfer");
    const from = page.getByLabel("From account", { exact: true });
    await choose(from, "HDFC Savings");
    // The destination list excludes the source account.
    await expect(page.getByLabel("To account", { exact: true }).locator("option", { hasText: "HDFC Savings" })).toHaveCount(0);
    await choose(page.getByLabel("To account", { exact: true }), "Wallet");
    await page.getByLabel("Amount", { exact: true }).fill("1,000");
    await page.getByRole("button", { name: "Record transfer" }).click();
    await expect(page.getByText(/Enter an amount greater than zero/)).toBeVisible();
    await expect(page.getByLabel("Amount", { exact: true })).toHaveValue("1,000");
  });

  test("balances and history reflect every transaction", async ({ page }) => {
    await openAccount(page, "HDFC Savings");
    await expect(balanceOn(page)).toHaveText("₹71,800.50"); // 50,000 + 25,000.50 − 1,200 − 2,000
    await openAccount(page, "Wallet");
    await expect(balanceOn(page)).toHaveText("₹2,000.00");

    await page.goto("/transactions");
    const list = page.getByRole("list", { name: "Transactions" });
    await expect(list.getByRole("listitem")).toHaveCount(4);
    await expect(list).toContainText("Salary");
    await expect(list).toContainText("+₹25,000.50");
    await expect(list).toContainText("−₹1,200.00");
    await expect(list).toContainText("HDFC Savings → Wallet");
    await expect(list).toContainText("Opening balance");

    await page.getByLabel("Type").selectOption("expense");
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(list.getByRole("listitem")).toHaveCount(1);
    await expect(list).toContainText("BigBasket");

    await page.goto("/transactions?q=bigbasket");
    await expect(list.getByRole("listitem")).toHaveCount(1);
    await page.goto("/transactions?from=2026-10-21&to=2026-10-22");
    await expect(list.getByRole("listitem")).toHaveCount(2);
  });

  test("void an expense through a reversal; it stays in history", async ({ page }) => {
    await page.goto("/transactions?type=expense");
    await page.getByRole("link", { name: /Groceries/ }).click();
    await page.getByRole("button", { name: "Void transaction" }).click();
    await expect(page.getByText(/Balances return to what they were/)).toBeFocused();
    await page.getByRole("button", { name: "Yes, void it" }).click();
    await expect(page.getByText("Void", { exact: true })).toBeVisible();
    await openAccount(page, "HDFC Savings");
    await expect(balanceOn(page)).toHaveText("₹73,000.50");
    await page.goto("/transactions");
    await expect(page.getByRole("list", { name: "Transactions" }).getByRole("listitem")).toHaveCount(4);
  });

  test("archive an account: no new transactions, history kept; then restore it", async ({ page }) => {
    await openAccount(page, "Wallet");
    await expect(page.getByRole("button", { name: "Delete account" })).toHaveCount(0); // it has history
    await page.getByRole("button", { name: "Archive account" }).click();
    await page.getByRole("button", { name: "Yes, archive" }).click();
    await expect(page.getByText(/This account is archived/)).toBeVisible();
    await expect(balanceOn(page)).toHaveText("₹2,000.00");

    await page.goto("/transactions/new?type=transfer");
    await expect(page.getByLabel("From account", { exact: true }).locator("option", { hasText: "Wallet" })).toHaveCount(0);

    await openAccount(page, "Wallet");
    await page.getByRole("button", { name: "Restore account" }).click();
    await page.getByRole("button", { name: "Yes, restore" }).click();
    await expect(page.getByText(/This account is archived/)).toHaveCount(0);
  });

  test("an unused account can be deleted after confirmation", async ({ page }) => {
    await page.goto("/accounts/new");
    await page.getByLabel("Account name").fill("Typo account");
    await page.getByRole("button", { name: "Create account" }).click();
    await page.getByRole("button", { name: "Delete account" }).click();
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Delete account" }).click();
    await page.getByRole("button", { name: "Yes, delete permanently" }).click();
    await expect(page).toHaveURL(/\/accounts$/);
    await expect(page.getByRole("link", { name: /Typo account/ })).toHaveCount(0);
  });

  test("correct the opening balance: original reversed, replacement recorded", async ({ page }) => {
    await openAccount(page, "HDFC Savings");
    await page.getByText("Correct the opening balance").click();
    await page.getByLabel(/^Opening balance/).fill("55000");
    await page.getByRole("button", { name: "Correct opening balance" }).click();
    await expect(page.getByText("₹55,000.00 as of 1 Oct 2026")).toBeVisible();
    await expect(balanceOn(page)).toHaveText("₹78,000.50");
  });
});
